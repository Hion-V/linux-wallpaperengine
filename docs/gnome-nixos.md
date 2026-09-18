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
The desktop surface stays in Mutter's window group. In Activities, live Clutter
clones supply each monitor's wallpaper to the large workspace previews and the
small thumbnail strip, behind application previews. Scoped, reversible hooks on
GNOME 50's overview actor constructors also cover newly created workspaces.
Large previews use uniform scaling with centered cropping, preserving the
wallpaper's aspect ratio as the card changes size. Clones follow GNOME's work-area
cropping and rounded preview corners, and are
removed when the renderer stops or the extension is disabled. Monitors without a
running wallpaper retain their normal background. The renderer submits an
empty input region so clicks pass through to GNOME or desktop icons.
See [Mutter's window type API](https://gnome.pages.gitlab.gnome.org/mutter/meta/method.Window.set_type.html)
and [GNOME 50's window implementation](https://gitlab.gnome.org/GNOME/mutter/-/blob/gnome-50/src/core/window.c).

Existing monitor layout/resolution changes update wallpaper geometry. Removing a
monitor closes its wallpaper; restart the renderer to use newly attached outputs.
Disabling the extension closes its wallpaper surfaces; the renderer exits when
its last output closes. A renderer disconnect releases its registrations. The
extension remains enabled under the lock screen, behind GNOME's screen shield.

Current limitations:

- The lock screen keeps GNOME's normal background; Activities uses the live wallpaper.
- Wallpapers do not receive mouse clicks/movement in bridge mode.
- GNOME bridge surfaces always use the desktop layer; `--layer` does not raise them.
- Integer Wayland buffer scaling is used; fractional scaling may supersample.

## Blur My Shell

With Blur My Shell v72 enabled, its Activities backdrop also uses the live
wallpaper. The bridge supplies each monitor's wallpaper inside Blur My Shell's
existing overview effect widget, so your blur pipeline, brightness, and other
effect settings still apply. No Blur My Shell files or settings are changed.

The integration handles either extension being enabled first, pipeline/background
recreation, and renderer restarts. Removing a wallpaper or disabling the bridge
reveals Blur My Shell's original image background again. If Blur My Shell is not
installed or its overview blur is disabled, the adapter does nothing.

This adapter targets the actor structure used by v72; future Blur My Shell
versions may need compatibility updates. Only its Activities backdrop is covered,
not its separate panel, lock-screen, or workspace-switch animation backgrounds.
Blurring live frames uses more GPU time while Activities is visible than blurring
a static image.

## Validation and troubleshooting

```sh
nix build path:.#linux-wallpaperengine path:.#gnome-extension
nix flake check path:.
# Or run the bridge lifecycle tests directly:
node tests/gnome-bridge.mjs
node tests/gnome-overview.mjs
node tests/gnome-blur-my-shell.mjs
node tests/gnome-preferences.mjs
```

A missing/disabled extension produces a bridge registration error before the
renderer maps a wallpaper. Inspect extension status and Shell logs with:

```sh
gnome-extensions info linux-wallpaperengine@almamu.github.io
journalctl --user -b | rg 'linux-wallpaperengine|WallpaperBridge|JS ERROR'
```

After changing extension JavaScript, log out and in. Disabling and enabling an
extension does not reliably invalidate GNOME's JavaScript module cache.

Run GNOME 50 integration tests in a disposable VM. A previous host test coincided
with a desktop Shell crash; a private bus does not isolate GPU or system resources.
The test requires explicit opt-in, with `gnome-shell`, `dconf`, `gdbus`,
`glib-compile-schemas`, `dbus-run-session`, and Python on PATH:

```sh
nix build path:. --out-link /tmp/lwe-build
python3 tests/gnome-headless.py --allow-host-compositor-test /tmp/lwe-build/bin/linux-wallpaperengine /path/to/ffmpeg
```

This starts a separate headless compositor on a private session bus, generates a
video, checks two monitors' geometry and desktop window state, captures desktop
and overview screenshots, verifies that overview frames keep changing, exercises
workspace creation/switching and renderer restarts, and verifies shutdown on
extension disable. It writes logs and the
screenshot to a reported temporary directory. Test-only diagnostics and screenshot
access are injected into the temporary extension copy, never the installed one.

Set `LWE_TEST_GJS` to a GJS executable with GTK 3 typelibs available to also test
a real fullscreen application, two renderer processes, pause/resume frames,
preferences opening, and filter changes. The compositor-free `pause-dbus` flake
check tests the C++ client against a private fake bridge, including service loss.

To include Blur My Shell in the headless test, pass its installed directory:

```sh
python3 tests/gnome-headless.py --allow-host-compositor-test /tmp/lwe-build/bin/linux-wallpaperengine /path/to/ffmpeg \
  --blur-my-shell ~/.local/share/gnome-shell/extensions/blur-my-shell@aunetx
```

The test copies it into the temporary session and checks the blurred backdrop's
animation, extension toggling, and image fallback when the renderer stops.

### Updating the extension

After rebuilding your NixOS configuration with this checkout, log out and back in
to load extension version 3, then start the wallpaper renderer again. If you use
the local symlink installation, rebuild `path:.#gnome-extension` and update the
symlink to the new output first. GNOME caches JavaScript modules, so toggling the
extension alone is not enough to load changed code.

## Fullscreen auto-pause and application filters

Fullscreen applications on any monitor of the current workspace pause all
bridge-connected renderer instances by default, including video and audio.
Minimized windows, other workspaces, and wallpaper windows do not trigger it.
Opening Activities resumes playback so its live previews keep animating.
Changes are picked up within roughly half a second while Shell is responsive.

Open the bridge's settings button in GNOME Extensions, or run:

```bash
gnome-extensions prefs linux-wallpaperengine@almamu.github.io
```

- **Pause for fullscreen applications:** enable or disable auto-pause.
- **Blacklist:** listed applications are ignored; other fullscreen apps pause playback.
- **Whitelist:** only listed fullscreen applications pause playback. An empty list never pauses.
- **Window classes / app IDs:** comma-separated exact matches, ignoring letter case.
  For example, `firefox, org.gnome.Terminal`. Press the entry's checkmark to apply.
  Each mode remembers its own list; switching modes displays that mode’s saved entries.
  Apply edits before switching. Existing shared-list entries are retained as the blacklist;
  the new whitelist starts empty. Both WM class and class instance are checked.

To inspect window classes, open GNOME Looking Glass (`Alt+F2`, then `lg`) and
use its Windows tab. Native Wayland applications expose their app ID as the class.
Preferences persist across logins and apply to running renderers.
`--no-fullscreen-pause` opts an individual renderer out. The wlroots-specific
`--fullscreen-pause-only-active` and `--fullscreen-pause-ignore-appid` flags do
not configure the GNOME bridge; use its preferences instead.

Rebuild both flake packages and log out/in after upgrading the bridge. The Nix
extension package includes the compiled settings schema and preferences window.

### Panel visibility with an otherwise empty monitor

The bridge prevents registered wallpaper windows from becoming direct-scanout
candidates in Mutter 50. Wallpapers must be composited with Shell's panel even
when no application or software cursor overlaps the monitor. This is separate
from clearing the window's fullscreen state. Other applications remain eligible
for direct scanout. The guard is removed when the wallpaper or extension closes.
