#pragma once

#include <dbus/dbus.h>
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
    }
    ~GnomeBridge () {
        dbus_connection_close (m_connection);
        dbus_connection_unref (m_connection);
    }
    GnomeBridge (const GnomeBridge&) = delete;
    GnomeBridge& operator= (const GnomeBridge&) = delete;

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
    DBusConnection* m_connection = nullptr;
};
}
