# Browser rendering performance

Web wallpapers use one CEF browser per wallpaper instance. A 3840×2160 view
contains 33.2 MB of BGRA pixels; a 1920×1080 view contains another 8.3 MB.
Uploading both views in full at 37 FPS transfers about 1.53 GB/s, before browser
readback, staging copies, and compositing. This is a bandwidth estimate, not a
measured upload rate.

The browser rendering changes on this branch:

- Clamp CEF's windowless frame limit to the configured FPS within CEF's 1–60
  range. Previously `max(60, fps)` forced at least 60 FPS.
- Use CEF's external message pump and `OnScheduleMessagePumpWork`. The main
  thread services scheduled work during the GLFW/Wayland frame limiter's wait,
  and before dispatching driver events, independent of individual output frame
  callbacks. Scene/video-only playback retains its ordinary sleep path.
- Keep CEF paint callbacks free of GL calls. A callback can belong to a different
  browser than the monitor whose context is current. Copy changed rows to a
  reusable CPU buffer and upload from the owning wallpaper's render function.
- Accumulate a bounding rectangle of damage until the next render. Unchanged
  pixels within the rectangle remain valid in the backing buffer. Allocate GL
  storage only on the first paint or a size change; upload damage with
  `glTexSubImage2D`, preserving the caller's texture and pixel-unpack state.
- Ignore popup paints and stale paint sizes rather than replacing the main
  texture. Detach callbacks when the wallpaper is destroyed.

A full-screen canvas can still dirty the whole view, in which case partial
uploads will offer little bandwidth improvement. The CPU staging buffer costs
four bytes per pixel per browser. No zero-copy claim is made.

## Remaining work

The pinned CEF 135 Linux header documents `shared_texture_enabled` as supported
only on Windows (D3D11). Although Linux accelerated-paint data structures exist,
this branch does not enable shared textures without a supported, validated
Linux producer path. A future CEF upgrade and EGL/dma-buf import implementation
must account for synchronization, buffer lifetime, modifiers, and a fallback.
See the upstream header:
https://github.com/chromiumembedded/cef/blob/7049/include/internal/cef_types_linux.h

The separately installed `simple-wallpaper-engine` Python launcher consumed
about 61% of one CPU core in a five-second sample, versus about 51% combined
for the engine and browser processes. Its source is not part of this repository.
Profile its Qt painting and timer handlers in that project; changing the engine
cannot remove launcher CPU usage.

## Validation

Run the upload regression test without CEF or a desktop:

```sh
c++ -std=c++20 -Itests/browser-render-stubs -Isrc \
  tests/browser-render-upload.cpp \
  src/WallpaperEngine/WebBrowser/CEF/RenderHandler.cpp \
  -o /tmp/browser-render-upload-test
/tmp/browser-render-upload-test
```

The test compiles the production handler against CEF/GL stubs and verifies
first-paint initialization, nonzero subrectangle offsets and row stride,
accumulated damage across callbacks, idle frames, resize, popup/stale frame
rejection, GL state restoration, and callbacks after detachment. Also available
as `nix build .#checks.x86_64-linux.browser-render-upload`.

For real browser validation, run the old and new executables with the same
wallpaper, resolution, FPS, and graphics driver. Verify that animation advances,
resize does not corrupt pixels, multiple outputs remain independent, and browser
work continues at low frame rates. Compare CPU time over equal steady-state
intervals. A private Xvfb window is useful for correctness checks but software
rendering results there are not representative of desktop GPU performance.

Validation on 2026-10-17: the complete pinned Nix engine build and packaged
upload check passed. The upload test also passed with AddressSanitizer and
UndefinedBehaviorSanitizer (LeakSanitizer disabled because the execution sandbox
prevents its process inspection). A private 320×180 Xvfb display showed a stable
green background and an alternating red/blue marker with the actual CEF renderer
at configured limits of 1, 10, and 37 FPS. Some private-display runs failed CEF
GPU initialization; the 37 FPS check passed when rerun alone. These checks do
not establish an FPS or CPU improvement on the live two-monitor desktop. The
installed renderer and live wallpaper were not replaced during validation.

## Black web wallpapers after the performance update

The first external-pump implementation could set its next wakeup to infinity
when CEF completed work without scheduling another task. With two browsers on
the GNOME/Wayland desktop, the diagnostic renderer received no paint callbacks;
the same renderer with one selected output received correctly sized paints and
uploaded them without GL errors. The Xvfb single-browser checks did not cover
this startup failure.

CEF's own external-pump example guarantees periodic service even without another
scheduling callback:
https://github.com/chromiumembedded/cef/blob/7049/tests/shared/browser/main_message_loop_external_pump.cc

`MessagePumpSchedule` now keeps a 33 ms fallback deadline, including after an
otherwise idle pump. Delayed scheduling requests cannot push that fallback past
33 ms from the last service. Clamp delays before converting them to clock
intervals. The deterministic `browser-message-pump.cpp` test covers idle startup,
repeated delayed requests, immediate requests, and very large delays. It runs
alongside the existing upload test in the packaged Nix browser check.

The corrected pinned Nix engine build and both packaged regression tests passed.
On the actual GNOME/Wayland desktop, the same two-output XP web wallpaper was
captured from both wallpaper FBOs five seconds after startup (1 FPS render limit,
so CEF must make progress between render frames). Before the correction the
capture was black; after it both the 1920×1080 and 3840×2160 views contained the
wallpaper and characters. This validates the native two-output path missing from
the original Xvfb checks. The desktop comparison used temporary renderer
processes and did not replace the installed system package.
