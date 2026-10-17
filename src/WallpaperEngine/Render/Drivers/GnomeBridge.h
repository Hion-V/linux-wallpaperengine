#pragma once

#include <dbus/dbus.h>
#include <chrono>
#include <cstdint>
#include <stdexcept>
#include <string>

namespace WallpaperEngine::Render::Drivers {
// Keep the connection alive: the extension revokes registrations on disconnect.
class GnomeBridge {
public:
    GnomeBridge () {
        DBusError error;
        dbus_error_init (&error);
        m_connection = dbus_bus_get_private (DBUS_BUS_SESSION, &error);
        const std::string message = error.message ? error.message : "Cannot connect to session bus";
        dbus_error_free (&error);
        if (!m_connection) throw std::runtime_error (message);
        dbus_connection_set_exit_on_disconnect (m_connection, false);
        // Startup match installation and owner lookup talk to the bus daemon;
        // the render loop never waits for Shell or for a method response.
        dbus_bus_add_match (m_connection,
            "type='signal',sender='org.gnome.Shell',path='/org/gnome/Shell/Extensions/LinuxWallpaperEngine',"
            "interface='io.github.almamu.LinuxWallpaperEngine',member='PauseStateChanged'", nullptr);
        dbus_bus_add_match (m_connection,
            "type='signal',sender='org.freedesktop.DBus',interface='org.freedesktop.DBus',"
            "member='NameOwnerChanged',arg0='org.gnome.Shell'", nullptr);
        // Authenticate signals and even the first asynchronous reply against
        // the bus daemon's unique owner, never a sender learned from a reply.
        auto* request = dbus_message_new_method_call (DBUS_SERVICE_DBUS, DBUS_PATH_DBUS,
            DBUS_INTERFACE_DBUS, "GetNameOwner");
        if (request) {
            const char* name = "org.gnome.Shell";
            dbus_message_append_args (request, DBUS_TYPE_STRING, &name, DBUS_TYPE_INVALID);
            auto* reply = dbus_connection_send_with_reply_and_block (m_connection, request, 1000, nullptr);
            dbus_message_unref (request);
            const char* owner;
            if (reply) {
                if (dbus_message_get_type (reply) == DBUS_MESSAGE_TYPE_METHOD_RETURN &&
                    dbus_message_has_sender (reply, DBUS_SERVICE_DBUS) &&
                    dbus_message_get_args (reply, nullptr, DBUS_TYPE_STRING, &owner, DBUS_TYPE_INVALID))
                    m_owner = owner;
                dbus_message_unref (reply);
            }
        }
    }
    ~GnomeBridge () {
        dbus_connection_close (m_connection);
        dbus_connection_unref (m_connection);
    }
    GnomeBridge (const GnomeBridge&) = delete;
    GnomeBridge& operator= (const GnomeBridge&) = delete;

    bool anythingFullscreen () {
        if (!dbus_connection_read_write (m_connection, 0)) {
            m_paused = false;
            return false;
        }
        while (auto* message = dbus_connection_pop_message (m_connection)) {
            handleMessage (message);
            dbus_message_unref (message);
        }
        const auto now = Clock::now ();
        if (m_requestSerial && now >= m_requestDeadline) {
            m_requestSerial = 0;
            if (m_generation == m_requestGeneration) m_paused = false; // fail open unless a newer signal arrived
            if (m_requestSubscription) m_nextSubscribe = now + std::chrono::seconds (5);
            m_signalMode = false;
            m_nextCheck = now + std::chrono::milliseconds (200);
        }
        if (!m_requestSerial && now >= m_nextCheck) requestPauseState (now);
        return m_paused;
    }

    std::string registerOutput (const std::string& output) {
        auto* request = dbus_message_new_method_call (
            "org.gnome.Shell", "/org/gnome/Shell/Extensions/LinuxWallpaperEngine",
            "io.github.almamu.LinuxWallpaperEngine", "Register");
        if (!request) throw std::bad_alloc ();
        const char* connector = output.c_str ();
        if (!dbus_message_append_args (request, DBUS_TYPE_STRING, &connector, DBUS_TYPE_INVALID)) {
            dbus_message_unref (request);
            throw std::bad_alloc ();
        }
        DBusError error;
        dbus_error_init (&error);
        auto* reply = dbus_connection_send_with_reply_and_block (m_connection, request, 5000, &error);
        dbus_message_unref (request);
        if (!reply) {
            const std::string message = error.message ? error.message : "No reply";
            dbus_error_free (&error);
            throw std::runtime_error ("GNOME wallpaper bridge unavailable. Enable linux-wallpaperengine@almamu.github.io: " + message);
        }
        const char* token = nullptr;
        const bool valid = dbus_message_get_args (reply, &error, DBUS_TYPE_STRING, &token, DBUS_TYPE_INVALID);
        const std::string result = valid ? token : "";
        dbus_message_unref (reply);
        dbus_error_free (&error);
        if (result.empty ()) throw std::runtime_error ("Invalid GNOME bridge registration reply");
        return result;
    }
private:
    using Clock = std::chrono::steady_clock;
    void requestPauseState (Clock::time_point now) {
        if (m_owner.empty ()) {
            m_nextCheck = now + std::chrono::milliseconds (200);
            return;
        }
        m_requestSubscription = !m_signalMode && now >= m_nextSubscribe;
        auto* request = dbus_message_new_method_call (
            "org.gnome.Shell", "/org/gnome/Shell/Extensions/LinuxWallpaperEngine",
            "io.github.almamu.LinuxWallpaperEngine",
            m_requestSubscription ? "SubscribePauseState" : "GetPauseState");
        m_nextCheck = now + (m_signalMode ? std::chrono::milliseconds (5000) : std::chrono::milliseconds (200));
        if (!request) return;
        dbus_message_set_auto_start (request, false);
        if (dbus_connection_send (m_connection, request, &m_requestSerial)) {
            m_requestDeadline = now + std::chrono::milliseconds (250);
            m_requestGeneration = m_generation;
        }
        dbus_message_unref (request);
        // Try to transmit now without waiting. Paused playback checks only
        // every 250 ms, so deferring the send until that check would consume
        // the entire response deadline before Shell even receives the query.
        // Never use send_with_reply_and_block or flush on this path.
        dbus_connection_read_write (m_connection, 0);
    }

    void handleMessage (DBusMessage* message) {
        if (dbus_message_is_signal (message, DBUS_INTERFACE_DBUS, "NameOwnerChanged") &&
            dbus_message_has_sender (message, DBUS_SERVICE_DBUS)) {
            const char *name, *oldOwner, *newOwner;
            if (dbus_message_get_args (message, nullptr, DBUS_TYPE_STRING, &name,
                    DBUS_TYPE_STRING, &oldOwner, DBUS_TYPE_STRING, &newOwner, DBUS_TYPE_INVALID) &&
                std::string (name) == "org.gnome.Shell") {
                m_owner = newOwner;
                m_paused = false;
                m_signalMode = false;
                m_requestSerial = 0;
                m_nextCheck = m_nextSubscribe = Clock::time_point {};
                ++m_generation;
            }
            return;
        }
        if (dbus_message_is_signal (message, "io.github.almamu.LinuxWallpaperEngine", "PauseStateChanged") &&
            dbus_message_has_path (message, "/org/gnome/Shell/Extensions/LinuxWallpaperEngine") &&
            !m_owner.empty () && dbus_message_has_sender (message, m_owner.c_str ())) {
            dbus_bool_t paused;
            if (dbus_message_get_args (message, nullptr, DBUS_TYPE_BOOLEAN, &paused, DBUS_TYPE_INVALID)) {
                m_paused = paused;
                ++m_generation;
            }
            return;
        }
        if (!m_requestSerial || dbus_message_get_reply_serial (message) != m_requestSerial) return;
        if (!dbus_message_has_sender (message, m_owner.c_str ()) &&
            !dbus_message_has_sender (message, DBUS_SERVICE_DBUS)) return;
        m_requestSerial = 0;
        const auto now = Clock::now ();
        dbus_bool_t paused;
        const char* sender = dbus_message_get_sender (message);
        if (dbus_message_get_type (message) == DBUS_MESSAGE_TYPE_METHOD_RETURN && sender &&
            (!m_owner.empty () && m_owner == sender) &&
            dbus_message_get_args (message, nullptr, DBUS_TYPE_BOOLEAN, &paused, DBUS_TYPE_INVALID)) {
            m_owner = sender;
            if (m_generation == m_requestGeneration) m_paused = paused;
            if (m_requestSubscription) m_signalMode = true;
            m_nextCheck = now + (m_signalMode ? std::chrono::milliseconds (5000) : std::chrono::milliseconds (200));
        } else {
            if (m_generation == m_requestGeneration) m_paused = false;
            m_signalMode = false;
            if (m_requestSubscription) {
                m_nextSubscribe = now + std::chrono::seconds (5);
                m_nextCheck = now; // asynchronous compatibility query on the next frame
            }
        }
    }

    bool m_paused = false;
    bool m_signalMode = false;
    bool m_requestSubscription = false;
    std::string m_owner;
    dbus_uint32_t m_requestSerial = 0;
    uint64_t m_generation = 0, m_requestGeneration = 0;
    Clock::time_point m_nextCheck {}, m_nextSubscribe {}, m_requestDeadline {};
    DBusConnection* m_connection = nullptr;
};
}
