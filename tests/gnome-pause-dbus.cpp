// Run on a private bus: dbus-run-session -- ./gnome-pause-dbus
#include "WallpaperEngine/Render/Drivers/GnomeBridge.h"
#include <atomic>
#include <algorithm>
#include <cassert>
#include <iostream>
#include <mutex>
#include <vector>
#include <thread>

using WallpaperEngine::Render::Drivers::GnomeBridge;
using namespace std::chrono_literals;

static constexpr const char* path = "/org/gnome/Shell/Extensions/LinuxWallpaperEngine";
static constexpr const char* interface = "io.github.almamu.LinuxWallpaperEngine";

template<class Predicate> void waitFor (Predicate predicate) {
    const auto end = std::chrono::steady_clock::now () + 2s;
    while (!predicate ()) {
        assert (std::chrono::steady_clock::now () < end);
        std::this_thread::sleep_for (2ms);
    }
}

int main () {
    assert (dbus_threads_init_default ());
    DBusConnection* server = dbus_bus_get_private (DBUS_BUS_SESSION, nullptr);
    assert (server);
    assert (dbus_bus_request_name (server, "org.gnome.Shell", DBUS_NAME_FLAG_DO_NOT_QUEUE, nullptr)
            == DBUS_REQUEST_NAME_REPLY_PRIMARY_OWNER);
    std::atomic<int> mode {0}; // signals, old extension, malformed response, held response
    std::atomic<bool> paused {false};
    std::atomic<int> requests {0};
    std::atomic<DBusMessage*> held {nullptr};
    std::atomic<bool> running {true};
    std::mutex clientsMutex;
    std::vector<std::string> clients;
    auto reply = [&] (DBusMessage* request, bool value) {
        auto* response = dbus_message_new_method_return (request);
        dbus_bool_t data = value;
        dbus_message_append_args (response, DBUS_TYPE_BOOLEAN, &data, DBUS_TYPE_INVALID);
        dbus_connection_send (server, response, nullptr);
        dbus_connection_flush (server);
        dbus_message_unref (response);
    };
    auto signal = [&] (bool value) {
        auto* message = dbus_message_new_signal (path, interface, "PauseStateChanged");
        dbus_bool_t data = value;
        dbus_message_append_args (message, DBUS_TYPE_BOOLEAN, &data, DBUS_TYPE_INVALID);
        dbus_connection_send (server, message, nullptr);
        dbus_connection_flush (server);
        dbus_message_unref (message);
    };
    std::thread service ([&] {
        while (running) {
            dbus_connection_read_write (server, 5);
            auto* request = dbus_connection_pop_message (server);
            if (!request) continue;
            const bool subscription = dbus_message_is_method_call (request, interface, "SubscribePauseState");
            if (subscription || dbus_message_is_method_call (request, interface, "GetPauseState")) {
                ++requests;
                {
                    std::lock_guard lock (clientsMutex);
                    const std::string client = dbus_message_get_sender (request);
                    if (std::find (clients.begin (), clients.end (), client) == clients.end ()) clients.push_back (client);
                }
                const int current = mode;
                if (current == 3 && !subscription) {
                    DBusMessage* empty = nullptr;
                    if (held.compare_exchange_strong (empty, request)) continue;
                } else if ((current == 1 || current == 3) && subscription) {
                    auto* response = dbus_message_new_error (request, DBUS_ERROR_UNKNOWN_METHOD, "Older extension");
                    dbus_connection_send (server, response, nullptr);
                    dbus_connection_flush (server);
                    dbus_message_unref (response);
                } else if (current == 2) {
                    auto* response = dbus_message_new_method_return (request);
                    const char* invalid = "invalid";
                    dbus_message_append_args (response, DBUS_TYPE_STRING, &invalid, DBUS_TYPE_INVALID);
                    dbus_connection_send (server, response, nullptr);
                    dbus_connection_flush (server);
                    dbus_message_unref (response);
                } else reply (request, paused);
            }
            dbus_message_unref (request);
        }
    });
    {
        GnomeBridge first, second;
        waitFor ([&] { first.anythingFullscreen (); second.anythingFullscreen (); return requests >= 2; });
        std::this_thread::sleep_for (30ms);
        assert (!first.anythingFullscreen () && !second.anythingFullscreen ());
        const int initial = requests;
        paused = true; signal (true);
        waitFor ([&] { return first.anythingFullscreen () && second.anythingFullscreen (); });
        paused = false; signal (false);
        waitFor ([&] { return !first.anythingFullscreen () && !second.anythingFullscreen (); });
        for (int i = 0; i < 30; ++i) {
            first.anythingFullscreen (); second.anythingFullscreen ();
            std::this_thread::sleep_for (10ms);
        }
        assert (requests == initial); // new extensions use signals, not frame-rate queries
        auto* attacker = dbus_bus_get_private (DBUS_BUS_SESSION, nullptr);
        {
            std::lock_guard lock (clientsMutex);
            for (const auto& client : clients) {
                auto* forged = dbus_message_new_signal (path, interface, "PauseStateChanged");
                dbus_message_set_destination (forged, client.c_str ());
                dbus_bool_t value = true;
                dbus_message_append_args (forged, DBUS_TYPE_BOOLEAN, &value, DBUS_TYPE_INVALID);
                dbus_connection_send (attacker, forged, nullptr);
                dbus_message_unref (forged);
            }
        }
        dbus_connection_flush (attacker);
        std::this_thread::sleep_for (30ms);
        assert (!first.anythingFullscreen () && !second.anythingFullscreen ());
        dbus_connection_close (attacker); dbus_connection_unref (attacker);

        {
            paused = true;
            GnomeBridge sparsePoll;
            assert (!sparsePoll.anythingFullscreen ());
            std::this_thread::sleep_for (280ms);
            assert (sparsePoll.anythingFullscreen ()); // queued requests must transmit before the paused-loop sleep
        }
        paused = false;

        mode = 1; paused = true;
        GnomeBridge oldExtension;
        waitFor ([&] { return oldExtension.anythingFullscreen (); });
        paused = false;
        waitFor ([&] { return !oldExtension.anythingFullscreen (); });
        paused = true;
        waitFor ([&] { return oldExtension.anythingFullscreen (); });
        mode = 2;
        waitFor ([&] { return !oldExtension.anythingFullscreen (); }); // malformed replies fail open

        mode = 3;
        waitFor ([&] { oldExtension.anythingFullscreen (); return held.load () != nullptr; });
        // A completely unresponsive Shell cannot stall a render-thread call.
        const auto start = std::chrono::steady_clock::now ();
        for (int i = 0; i < 100; ++i) oldExtension.anythingFullscreen ();
        assert (std::chrono::steady_clock::now () - start < 100ms);
        // A newer authoritative signal must win over the in-flight snapshot.
        signal (true);
        waitFor ([&] { return oldExtension.anythingFullscreen (); });
        if (auto* request = held.exchange (nullptr)) { reply (request, false); dbus_message_unref (request); }
        std::this_thread::sleep_for (30ms);
        assert (oldExtension.anythingFullscreen ());
        mode = 1;
        paused = false;
        waitFor ([&] { return !oldExtension.anythingFullscreen (); });

        paused = true;
        waitFor ([&] { return oldExtension.anythingFullscreen (); });
        mode = 3;
        waitFor ([&] { oldExtension.anythingFullscreen (); return held.load () != nullptr; });
        waitFor ([&] { return !oldExtension.anythingFullscreen (); });
        std::this_thread::sleep_for (280ms);
        assert (!oldExtension.anythingFullscreen ());
        if (auto* request = held.exchange (nullptr)) dbus_message_unref (request);
        mode = 0; paused = true;
        signal (true);
        waitFor ([&] { return first.anythingFullscreen () && second.anythingFullscreen (); });
        running = false;
        service.join ();
        if (auto* request = held.exchange (nullptr)) dbus_message_unref (request);
        dbus_connection_close (server);
        dbus_connection_unref (server);
        waitFor ([&] { return !first.anythingFullscreen () && !second.anythingFullscreen (); });

        GnomeBridge missingService;
        assert (!missingService.anythingFullscreen ());

        // Restart under another unique bus owner; existing clients must resubscribe.
        server = dbus_bus_get_private (DBUS_BUS_SESSION, nullptr);
        assert (dbus_bus_request_name (server, "org.gnome.Shell", DBUS_NAME_FLAG_DO_NOT_QUEUE, nullptr)
                == DBUS_REQUEST_NAME_REPLY_PRIMARY_OWNER);
        std::atomic<bool> restartRunning {true};
        std::thread restarted ([&] {
            while (restartRunning) {
                dbus_connection_read_write (server, 5);
                if (auto* request = dbus_connection_pop_message (server)) {
                    if (dbus_message_is_method_call (request, interface, "SubscribePauseState")) reply (request, true);
                    dbus_message_unref (request);
                }
            }
        });
        waitFor ([&] { return first.anythingFullscreen () && second.anythingFullscreen (); });
        waitFor ([&] { return missingService.anythingFullscreen (); });
        restartRunning = false; restarted.join ();
        dbus_connection_close (server); dbus_connection_unref (server);
    }
    std::cout << "PASS: signal delivery, nonblocking calls, old extensions, stale replies, timeout, and service restart\n";
}
