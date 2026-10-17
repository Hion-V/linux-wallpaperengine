#pragma once

#include "WallpaperEngine/Application/ApplicationContext.h"
#include "WallpaperEngine/Application/WallpaperApplication.h"
#include "include/cef_app.h"
#include "include/cef_browser_process_handler.h"
#include "include/wrapper/cef_helpers.h"

#include <chrono>
#include <condition_variable>
#include <mutex>

#define WPENGINE_SCHEME "wp"

namespace WallpaperEngine::WebBrowser::CEF {
class BrowserApp;
}

namespace WallpaperEngine::WebBrowser {
class WebBrowserContext {
public:
    explicit WebBrowserContext (WallpaperEngine::Application::WallpaperApplication& wallpaperApplication);
    ~WebBrowserContext ();

    // All pumping stays on the CEF UI/application thread. Scheduling may come
    // from any CEF thread and wakes a frame wait when earlier work arrives.
    void scheduleMessagePumpWork (int64_t delayMs);
    void pumpEvents ();
    void waitForEvents (double seconds);

private:
    using Clock = std::chrono::steady_clock;
    std::mutex m_pumpMutex;
    std::condition_variable m_pumpWake;
    Clock::time_point m_nextPump = Clock::now ();
    CefRefPtr<CefApp> m_browserApplication = nullptr;
    CefRefPtr<CefCommandLine> m_commandLine = nullptr;
    WallpaperEngine::Application::WallpaperApplication& m_wallpaperApplication;
};
} // namespace WallpaperEngine::WebBrowser
