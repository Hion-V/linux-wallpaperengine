# NixOS and GNOME 50

The flake builds this checkout, including the GNOME bridge changes. It provides
`linux-wallpaperengine` (also `default`), `gnome-extension`, a development shell,
and an optional NixOS module for x86_64-linux and aarch64-linux. Dependencies,
including the Git submodule revisions and CEF, are pinned; builds do not require
initializing submodules or downloading dependencies from CMake.

## Install

Add this repository as an input to your system flake (replace the path):

```nix
inputs.wallpaperengine.url = "path:/absolute/path/to/linux-wallpaperengine";
```

Add these to your NixOS configuration, with `wallpaperengine` passed from your
flake's inputs:

```nix
imports = [ wallpaperengine.nixosModules.default ];
programs.linux-wallpaperengine.enable = true;
```

Rebuild NixOS, log out and back in so Shell discovers the extension, then enable it:

```sh
gnome-extensions enable linux-wallpaperengine@almamu.github.io
```

The module installs the application and extension. It does not change your
GNOME settings or start a wallpaper automatically. You can alternatively install
`wallpaperengine.packages.${pkgs.stdenv.hostPlatform.system}.linux-wallpaperengine`
and `.gnome-extension` in `environment.systemPackages` or Home Manager's
`home.packages`. Home Manager can enable the extension declaratively:

```nix
dconf.settings."org/gnome/shell".enabled-extensions = [
  "linux-wallpaperengine@almamu.github.io"
];
```

For a local extension installation without rebuilding NixOS:

```sh
nix build path:.#gnome-extension --out-link /tmp/lwe-extension
mkdir -p ~/.local/share/gnome-shell/extensions
ln -s "$(realpath /tmp/lwe-extension)/share/gnome-shell/extensions/linux-wallpaperengine@almamu.github.io" \
  ~/.local/share/gnome-shell/extensions/linux-wallpaperengine@almamu.github.io
```

Log out and in, then enable it as above. Remove this symlink before switching to
system installation. `path:.` includes new files in a working checkout; after
committing the flake and bridge, the usual `nix run .` syntax works too.

## Run

After installing through the NixOS module or Home Manager and enabling the
extension, open a terminal in your GNOME session and run:

```sh
linux-wallpaperengine --screen-root DP-1 --bg /path/to/workshop/wallpaper
```

Replace `DP-1` with your monitor's connector name and the path with a wallpaper
folder containing `project.json`. For a wallpaper downloaded through Steam, you
can instead pass its Workshop ID:

```sh
linux-wallpaperengine --screen-root DP-1 --bg 2370927443
```

The application is a command-line renderer; running it starts the wallpaper
directly. Keep it running to keep the wallpaper visible. Press `Ctrl+C` in that
terminal to stop it. Enabling the GNOME extension alone does not start the renderer.

To find your monitor's connector name (for example `DP-1`, `HDMI-1`, or `eDP-1`),
inspect GNOME's display configuration:

```sh
gdbus call --session --dest org.gnome.Mutter.DisplayConfig \
  --object-path /org/gnome/Mutter/DisplayConfig \
  --method org.gnome.Mutter.DisplayConfig.GetCurrentState
```

If you have not installed the application, run it from this repository instead
(the GNOME extension must still be installed and enabled):

```sh
nix run path:. -- --screen-root DP-1 --bg /path/to/workshop/wallpaper
```

For different wallpapers on two displays with the installed application:

```sh
linux-wallpaperengine --screen-root DP-1 --bg /path/to/first \
  --screen-root HDMI-1 --bg /path/to/second
```

Steam Workshop IDs and `--screen-span` work through the existing application
options. Wallpaper Engine assets are still required by scene/web wallpapers;
use `--assets-dir /path/to/Wallpaper\ Engine/assets` if discovery fails. The flake
does not redistribute Steam content. Window previews continue to use the normal
preview backend.

## How the bridge works

On a Wayland compositor without layer-shell, the renderer registers each monitor
with `io.github.almamu.LinuxWallpaperEngine.Register(s) → s` at
`/org/gnome/Shell/Extensions/LinuxWallpaperEngine` on `org.gnome.Shell`.
The extension derives the registering process's PID from its D-Bus sender and
returns a unique app ID. The renderer creates an xdg-shell surface with that ID.
Only a native Wayland window with both the registered ID and PID is accepted;
each registration can claim one window.

GNOME 50's Mutter desktop window type supplies bottom stacking, no initial focus,
and visibility on all workspaces. The extension hides the window from window
lists and sizes it to the full monitor, including the area behind the panel.
No Shell method overrides or actor reparenting are used. The renderer submits an
empty input region so clicks pass through to GNOME or desktop icons.
See [Mutter's window type API](https://gnome.pages.gitlab.gnome.org/mutter/meta/method.Window.set_type.html)
and [GNOME 50's window implementation](https://gitlab.gnome.org/GNOME/mutter/-/blob/gnome-50/src/core/window.c).

Existing monitor layout/resolution changes update wallpaper geometry. Removing a
monitor closes its wallpaper; restart the renderer to use newly attached outputs.
Disabling the extension closes its wallpaper surfaces; the renderer exits when
its last output closes. A renderer disconnect releases its registrations. The
extension remains enabled under the lock screen, behind GNOME's screen shield.

Current limitations:

- The overview and lock screen keep GNOME's normal backgrounds.
- Wallpapers do not receive mouse clicks/movement in bridge mode.
- The existing fullscreen-pause detector requires wlroots' foreign-toplevel
  protocol, which GNOME does not expose; fullscreen auto-pause is unavailable.
- GNOME bridge surfaces always use the desktop layer; `--layer` does not raise them.
- Integer Wayland buffer scaling is used; fractional scaling may supersample.

## Validation and troubleshooting

```sh
nix build path:.#linux-wallpaperengine path:.#gnome-extension
nix flake check path:.
# Or run the bridge lifecycle tests directly:
node tests/gnome-bridge.mjs
```

A missing/disabled extension produces a bridge registration error before the
renderer maps a wallpaper. Inspect extension status and Shell logs with:

```sh
gnome-extensions info linux-wallpaperengine@almamu.github.io
journalctl --user -b | rg 'linux-wallpaperengine|WallpaperBridge|JS ERROR'
```

After changing extension JavaScript, log out and in. Disabling and enabling an
extension does not reliably invalidate GNOME's JavaScript module cache.

For an isolated GNOME 50 integration test, with `gnome-shell`, `dconf`, `gdbus`,
`dbus-run-session`, and Python on PATH:

```sh
nix build path:. --out-link /tmp/lwe-build
python3 tests/gnome-headless.py /tmp/lwe-build/bin/linux-wallpaperengine /path/to/ffmpeg
```

This starts a separate headless compositor on a private session bus, generates a
video, checks two monitors' geometry and desktop window state, captures a
screenshot, and verifies shutdown on extension disable. It writes logs and the
screenshot to a reported temporary directory. Test-only diagnostics and screenshot
access are injected into the temporary extension copy, never the installed one.
