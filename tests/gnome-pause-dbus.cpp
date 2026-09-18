// Run on a private bus: dbus-run-session -- ./gnome-pause-dbus
#include "WallpaperEngine/Render/Drivers/GnomeBridge.h"
#include <atomic>
#include <cassert>
#include <thread>

using WallpaperEngine::Render::Drivers::GnomeBridge;
using namespace std::chrono_literals;

int main () {
    assert (dbus_threads_init_default ());
    DBusConnection* server = dbus_bus_get_private (DBUS_BUS_SESSION, nullptr);
    assert (server);
    assert (dbus_bus_request_name (server, "org.gnome.Shell", DBUS_NAME_FLAG_DO_NOT_QUEUE, nullptr)
            == DBUS_REQUEST_NAME_REPLY_PRIMARY_OWNER);
    std::atomic<int> mode {0}; // playing, paused, old extension, malformed response
    std::atomic<int> requests {0};
    std::atomic<bool> running {true};
    std::thread service ([&] {
        while (running) {
            dbus_connection_read_write (server, 20);
            auto* request = dbus_connection_pop_message (server);
            if (!request) continue;
            if (dbus_message_is_method_call (request, "io.github.almamu.LinuxWallpaperEngine", "GetPauseState")) {
                ++requests;
                const int current = mode;
                auto* reply = current == 2
                    ? dbus_message_new_error (request, DBUS_ERROR_UNKNOWN_METHOD, "Older bridge")
                    : dbus_message_new_method_return (request);
                if (current == 3) {
                    const char* invalid = "invalid";
                    dbus_message_append_args (reply, DBUS_TYPE_STRING, &invalid, DBUS_TYPE_INVALID);
                } else if (current != 2) {
                    dbus_bool_t paused = current == 1;
                    dbus_message_append_args (reply, DBUS_TYPE_BOOLEAN, &paused, DBUS_TYPE_INVALID);
                }
                dbus_connection_send (server, reply, nullptr);
                dbus_connection_flush (server);
                dbus_message_unref (reply);
            }
            dbus_message_unref (request);
        }
    });
    {
        GnomeBridge first, second;
        assert (!first.anythingFullscreen ());
        const int initial = requests;
        for (int i = 0; i < 20; ++i) assert (!first.anythingFullscreen ());
        assert (requests == initial); // frame-rate polling must not flood Shell
        mode = 1;
        std::this_thread::sleep_for (220ms);
        assert (first.anythingFullscreen ());
        assert (second.anythingFullscreen ());
        mode = 0;
        std::this_thread::sleep_for (220ms);
        assert (!first.anythingFullscreen ());
        assert (!second.anythingFullscreen ());
        for (int failure : {2, 3}) {
            mode = failure;
            std::this_thread::sleep_for (220ms);
            assert (!first.anythingFullscreen ());
        }
        mode = 1;
        std::this_thread::sleep_for (220ms);
        assert (first.anythingFullscreen ());
        running = false;
        service.join ();
        dbus_connection_close (server);
        dbus_connection_unref (server);
        std::this_thread::sleep_for (220ms);
        assert (!first.anythingFullscreen ()); // service loss must release a pause
    }
}
