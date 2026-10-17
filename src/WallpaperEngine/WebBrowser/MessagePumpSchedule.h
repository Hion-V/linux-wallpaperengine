#pragma once

#include <algorithm>
#include <chrono>
#include <cstdint>

namespace WallpaperEngine::WebBrowser {
// CEF's external-pump example polls at least every 33 ms, even when no task
// schedules a wakeup. IPC/native events can otherwise leave a browser stalled.
// The caller serializes access; clock arguments keep deadline tests deterministic.
class MessagePumpSchedule {
public:
    using Clock = std::chrono::steady_clock;
    explicit MessagePumpSchedule (Clock::time_point now = Clock::now ()) : m_next (now), m_fallback (now + std::chrono::milliseconds (33)) {}

    void schedule (int64_t delayMs, Clock::time_point now = Clock::now ()) {
        m_next = std::min (m_fallback, now + std::chrono::milliseconds (std::clamp<int64_t> (delayMs, 0, 33)));
    }

    bool takeWork (Clock::time_point now = Clock::now ()) {
        if (now < m_next) return false;
        // Establish the fallback before CEF runs; any callback can replace it.
        m_fallback = now + std::chrono::milliseconds (33);
        m_next = m_fallback;
        return true;
    }

    Clock::time_point deadline () const { return m_next; }

private:
    Clock::time_point m_next;
    Clock::time_point m_fallback;
};
}
