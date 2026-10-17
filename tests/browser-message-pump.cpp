#include "WallpaperEngine/WebBrowser/MessagePumpSchedule.h"
#include <cassert>
#include <iostream>
#include <limits>

int main () {
    using WallpaperEngine::WebBrowser::MessagePumpSchedule;
    using namespace std::chrono_literals;
    const MessagePumpSchedule::Clock::time_point start {};
    MessagePumpSchedule schedule (start);
    assert (schedule.takeWork (start));
    assert (!schedule.takeWork (start + 32ms));
    // No CEF callback follows the initial work: IPC/native work must still run.
    assert (schedule.takeWork (start + 33ms));
    assert (schedule.takeWork (start + 66ms));
    schedule.schedule (0, start + 67ms);
    assert (schedule.takeWork (start + 67ms));
    schedule.schedule (5000, start + 68ms);
    assert (schedule.deadline () == start + 100ms);
    schedule.schedule (5000, start + 99ms);
    assert (schedule.deadline () == start + 100ms); // Repeated requests cannot postpone fallback.
    assert (schedule.takeWork (start + 100ms));
    schedule.schedule (std::numeric_limits<int64_t>::max (), start + 101ms);
    assert (schedule.deadline () == start + 133ms); // Clamp before duration conversion.
    schedule.schedule (-1, start + 102ms);
    assert (schedule.takeWork (start + 102ms));
    schedule.schedule (5, start + 103ms);
    assert (!schedule.takeWork (start + 107ms));
    assert (schedule.takeWork (start + 108ms));
    std::cout << "PASS: browser pump fallback, delayed work, immediate work, and oversized delays\n";
}
