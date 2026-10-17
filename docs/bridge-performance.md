# GNOME bridge performance

The renderer no longer waits for a synchronous pause-state response from GNOME
Shell during playback. Extension version 5 adds `SubscribePauseState` (the
initial Boolean state) and `PauseStateChanged(Boolean)` signals. Clients install
their signal match before requesting the initial state. The bridge keeps one
private D-Bus connection for registration and pause updates.

`anythingFullscreen()` performs nonblocking I/O and reads a cached value. It
allows only one outstanding request, with a 250 ms response deadline. The new
extension normally sends state changes; a nonblocking five-second heartbeat
recovers from interface failures. Old extensions return UnknownMethod for the
subscription handshake and use asynchronous 200 ms compatibility queries. The
handshake is retried after five seconds so clients can upgrade without restarting.
A lost service, malformed response or unanswered request releases a pause rather
than trapping playback. Late snapshots cannot overwrite newer state signals.
Unique-owner verification, including the initial owner lookup through the bus
daemon, prevents another application from supplying pause signals. Ownership
changes reset state and resubscribe. Requests are transmitted immediately with
nonblocking I/O so the paused-loop sleep does not consume their response deadline.
Signals are consumed at the existing render/paused checks; the paused loop retains
its 250 ms cadence. Startup registration and bus-daemon setup
remain synchronous; neither occurs on the frame-by-frame pause-check path.

The extension caches filter settings, registered renderer PIDs and the pause
state. Window changes, active-workspace changes, settings changes and Activities
visibility invalidate it. Idle processing coalesces multiple notifications; the
GetPauseState compatibility method flushes a dirty update once and then returns
the cached result. Only tracked fullscreen windows are examined, instead of
rebuilding filter sets and scanning every Shell actor on every request. The
per-monitor wallpaper source is cached for overview and workspace consumers.

## Compositing protection

The existing global unredirect inhibitor protects exposed live wallpapers and
must not simply be removed (see `gnome-crash-investigation.md`). It is released
only when the global pause policy is active, Activities is hidden, and fullscreen
windows cover the geometry of every registered wallpaper output. A fullscreen
flag alone is insufficient. One uncovered monitor keeps the inhibitor active.
Invalidating the state immediately reacquires it until coverage is recomputed;
Activities restores it before displaying live previews. Inhibitor ownership
remains balanced on unregister and extension disable.

GNOME Shell 50 also holds its own reference-counted unredirect inhibitor during
workspace-switch animations, independently of the bridge:
https://github.com/GNOME/gnome-shell/blob/50.5/js/ui/workspaceAnimation.js

## Overview and blur integration

Overview synchronization now caches per-monitor work areas, updates only changed
shader uniforms, and avoids restacking an already-topmost clone. Rounded resource
scale changes invalidate the uniform cache and retain the existing redraw fix.
Thumbnail and Blur My Shell clones are moved/resized only when geometry changes.
New backgrounds still cause the clone to be raised as needed. Live clones,
clipping, monitor selection, and source destruction retain their existing roles.
This does not lower wallpaper resolution or change the browser pixel pipeline.

## Validation

Run the packaged checks:

```sh
nix build .#checks.x86_64-linux.bridge .#checks.x86_64-linux.pause-dbus
nix build .#linux-wallpaperengine .#gnome-extension
```

The Node tests exercise cached pause reads, coalesced state signals, filter modes,
workspace/minimize changes, full/partial fullscreen coverage, pending configure
geometry, balanced inhibitor lifecycle, clone replacement, unchanged geometry and
uniforms, rounded resource scale changes, and teardown. The private-bus C++ test
exercises two subscribers, old-extension fallback, a stalled service without
blocking the caller, malformed/late replies, foreign signals, timeouts and
service-owner restart.

These checks do not establish a desktop FPS or CPU speedup. Actual scanout and
Shell integration should be validated in a disposable GNOME 50 VM before rollout.
The existing headless compositor test explicitly warns against running it on a
working desktop because an earlier run coincided with a Shell crash. This branch
does not replace or reload the user's running extension.

Validation on 2026-10-17: the final renderer and extension packages built
successfully. Packaged bridge tests and private-bus integration tests passed,
including the sparse 250 ms paused-loop case and startup without a service.
The standalone workspace-spacing regression also passed. No live extension
reload, compositor restart, or production-branch change was performed.
