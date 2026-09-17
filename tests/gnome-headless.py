#!/usr/bin/env python3
"""Integration test against an installed GNOME 50, in a private D-Bus session.

Usage: python3 tests/gnome-headless.py /path/to/linux-wallpaperengine /path/to/ffmpeg
Requires gnome-shell, dconf, gdbus and dbus-run-session on PATH. Uses temporary
XDG directories, two virtual monitors, and a generated video (no Steam assets).
"""
import argparse
import ast
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time

UUID = 'linux-wallpaperengine@almamu.github.io'
BLUR_UUID = 'blur-my-shell@aunetx'
ROOT = Path(__file__).resolve().parents[1]


def call(path, method, *args):
    result = subprocess.check_output([
        'gdbus', 'call', '--session', '--dest', 'org.gnome.Shell',
        '--object-path', path, '--method', method, *args,
    ], text=True, stderr=subprocess.DEVNULL, timeout=5)
    return result


def state():
    value = call('/org/gnome/Shell/Extensions/LinuxWallpaperEngine',
                 'io.github.almamu.LinuxWallpaperEngine.TestState')
    return json.loads(ast.literal_eval(value)[0])


def action(name):
    call('/org/gnome/Shell/Extensions/LinuxWallpaperEngine',
         'io.github.almamu.LinuxWallpaperEngine.TestAction', name)


def wait_for(fn, timeout=20):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            value = fn()
            if value:
                return value
        except (subprocess.SubprocessError, ValueError):
            pass
        time.sleep(0.2)
    raise AssertionError('Timed out waiting for GNOME test condition')


def inside(renderer, directory):
    directory = Path(directory)
    use_blur = os.environ.get('LWE_TEST_BLUR_MY_SHELL') == '1'
    extensions = [BLUR_UUID, UUID] if use_blur else [UUID]
    subprocess.run(['dconf', 'load', '/'], input=f'''[org/gnome/shell]
enabled-extensions={extensions}
disable-user-extensions=false
welcome-dialog-last-shown-version='50.4'

[org/gnome/mutter]
dynamic-workspaces=false
workspaces-only-on-primary=false

[org/gnome/desktop/wm/preferences]
num-workspaces=2

[org/gnome/shell/extensions/blur-my-shell/overview]
blur=true

[org/gnome/shell/extensions/blur-my-shell/panel]
blur=false

[org/gnome/shell/extensions/blur-my-shell/dash-to-dock]
blur=false

[org/gnome/shell/extensions/blur-my-shell/screenshot]
blur=false

[org/gnome/shell/extensions/blur-my-shell/lockscreen]
blur=false
''', text=True, check=True)
    with (directory / 'shell.log').open('w') as shell_log, (directory / 'renderer.log').open('w') as renderer_log:
        shell = subprocess.Popen([
            'gnome-shell', '--headless', '--wayland', '--no-x11',
            '--virtual-monitor', '1280x720', '--virtual-monitor', '1024x768',
            '--wayland-display', 'lwe-test',
        ], stdout=shell_log, stderr=subprocess.STDOUT)
        app = None
        try:
            wait_for(lambda: state()['ready'])
            action('hide')
            app = subprocess.Popen([
                renderer, '--assets-dir', str(directory / 'assets'), '--silent',
                '--no-audio-processing', '--noautomute',
                '--screen-root', 'Meta-0', '--bg', str(directory / 'wallpaper'),
                '--screen-root', 'Meta-1', '--bg', str(directory / 'wallpaper'),
            ], stdout=renderer_log, stderr=subprocess.STDOUT,
                env={**os.environ, 'WAYLAND_DISPLAY': 'lwe-test', 'SDL_AUDIODRIVER': 'dummy'})
            current = wait_for(lambda: (s if len((s := state())['windows']) == 2 else None))
            # Let initial configure and the first video frames reach the compositor.
            time.sleep(3)
            current = state()
            assert app.poll() is None, 'Renderer exited unexpectedly'
            expected = sorted(current['monitors'])
            actual = sorted(w['rect'] for w in current['windows'])
            assert actual == expected, (actual, expected)
            for window in current['windows']:
                assert window['type'] == 1, window  # Meta.WindowType.DESKTOP
                assert window['skip'] and window['sticky'] and not window['focus'], window
            print('PASS: two native desktop windows, exact monitor geometry, no taskbar/focus')
            screenshot = directory / 'desktop.png'
            call('/org/gnome/Shell/Screenshot', 'org.gnome.Shell.Screenshot.Screenshot',
                 'false', 'false', str(screenshot))
            assert screenshot.exists(), 'No rendered desktop screenshot'
            print(f'Desktop screenshot: {screenshot}')
            action('show')
            time.sleep(2)
            overview = state()
            assert overview['overview'], 'Activities overview did not open'
            mirrors = overview['mirrors']
            assert any(not m['thumbnail'] for m in mirrors), mirrors
            assert any(m['thumbnail'] for m in mirrors), mirrors
            assert all(m['live'] for m in mirrors), mirrors
            assert {m['monitor'] for m in mirrors} == {0, 1}, mirrors
            for mirror in mirrors:
                if not mirror['thumbnail']:
                    sw, sh = mirror['sourceSize']
                    cw, ch = mirror['cloneSize']
                    assert abs(cw / sw - ch / sh) < 0.003, f'Nonuniform preview scaling: {mirror}'
            print('PASS: workspace previews scale uniformly without squashing')
            if use_blur:
                assert len(overview['blurMirrors']) == 2, overview
                assert all(m['live'] and m['effects'] > 0 for m in overview['blurMirrors']), overview
                print('PASS: live wallpaper inside Blur My Shell effect pipelines on both monitors')
            for name in ['overview', 'overview-next-frame']:
                time.sleep(0.4)
                call('/org/gnome/Shell/Screenshot', 'org.gnome.Shell.Screenshot.Screenshot',
                     'false', 'false', str(directory / f'{name}.png'))
            # Compare pixels inside each on-screen workspace card, excluding Shell
            # chrome. A source reference alone would not catch frozen frame callbacks.
            for monitor_index, monitor in enumerate(overview['monitors']):
                card = next(m for m in mirrors if not m['thumbnail'] and m['monitor'] == monitor_index
                    and monitor[0] <= m['rect'][0] + m['rect'][2] / 2 < monitor[0] + monitor[2])
                x, y, width, height = card['rect']
                crop = f'crop={int(width / 2)}:{int(height / 2)}:{int(x + width / 4)}:{int(y + height / 4)}'
                frames = [subprocess.check_output([
                    os.environ['LWE_TEST_FFMPEG'], '-v', 'error', '-i', str(directory / f'{name}.png'),
                    '-vf', crop, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-',
                ]) for name in ['overview', 'overview-next-frame']]
                assert frames[0] != frames[1], f'Wallpaper frozen in overview on monitor {monitor_index}'
            print('PASS: animated wallpaper in workspace previews and thumbnails on both monitors')
            if use_blur:
                for name in ['blur-backdrop', 'blur-backdrop-next-frame']:
                    action('hide-cards')
                    time.sleep(0.4)
                    call('/org/gnome/Shell/Screenshot', 'org.gnome.Shell.Screenshot.Screenshot',
                         'false', 'false', str(directory / f'{name}.png'))
                # With workspace cards hidden only the blurred backdrop remains.
                for monitor_index, (x, y, width, height) in enumerate(overview['monitors']):
                    crop = f'crop={width // 2}:{height // 2}:{x + width // 4}:{y + height // 4}'
                    frames = [subprocess.check_output([
                        os.environ['LWE_TEST_FFMPEG'], '-v', 'error', '-i', str(directory / f'{name}.png'),
                        '-vf', crop, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-',
                    ]) for name in ['blur-backdrop', 'blur-backdrop-next-frame']]
                    assert frames[0] != frames[1], f'Blurred wallpaper frozen on monitor {monitor_index}'
                action('show-cards')
                call('/org/gnome/Shell', 'org.gnome.Shell.Extensions.DisableExtension', BLUR_UUID)
                wait_for(lambda: not state()['blurMirrors'])
                call('/org/gnome/Shell', 'org.gnome.Shell.Extensions.EnableExtension', BLUR_UUID)
                wait_for(lambda: len(state()['blurMirrors']) == 2 and all(m['live'] for m in state()['blurMirrors']))
                print('PASS: blurred backdrop animates and handles Blur My Shell disable/re-enable')
            action('add-workspace')
            time.sleep(1)
            assert len(state()['mirrors']) > len(mirrors), 'New workspace has no wallpaper'
            action('switch-workspace')
            time.sleep(1)
            assert all(m['live'] for m in state()['mirrors'])
            action('hide')
            time.sleep(1)
            action('show')
            time.sleep(1)
            assert all(m['live'] for m in state()['mirrors'])
            print('PASS: workspace creation, switching, and repeated overview transitions')
            action('change-background')
            time.sleep(1)
            assert all(m['live'] for m in state()['mirrors'])
            renderer_args = app.args
            app.terminate()
            app.wait(timeout=10)
            wait_for(lambda: not state()['windows'] and not any(m['live'] for m in state()['mirrors']))
            if use_blur:
                wait_for(lambda: not any(m['live'] for m in state()['blurMirrors']))
            app = subprocess.Popen(renderer_args, stdout=renderer_log, stderr=subprocess.STDOUT,
                env={**os.environ, 'WAYLAND_DISPLAY': 'lwe-test', 'SDL_AUDIODRIVER': 'dummy'})
            wait_for(lambda: len(state()['windows']) == 2 and all(m['live'] for m in state()['mirrors']))
            if use_blur:
                wait_for(lambda: all(m['live'] for m in state()['blurMirrors']))
            print('PASS: background changes and renderer restart while Activities remains open')
            call('/org/gnome/Shell', 'org.gnome.Shell.Extensions.DisableExtension', UUID)
            assert app.wait(timeout=10) == 0, 'Renderer did not exit cleanly on extension disable'
            print('PASS: disabling the bridge closes both outputs and stops the renderer')
        finally:
            if app and app.poll() is None:
                app.terminate()
                app.wait(timeout=10)
            shell.terminate()
            shell.wait(timeout=10)


def main():
    if len(sys.argv) == 4 and sys.argv[1] == '--inside':
        inside(sys.argv[2], sys.argv[3])
        return
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('renderer')
    parser.add_argument('ffmpeg')
    parser.add_argument('--blur-my-shell', type=Path, help='Installed Blur My Shell extension directory')
    args = parser.parse_args()
    renderer, ffmpeg = map(os.path.abspath, [args.renderer, args.ffmpeg])
    directory = Path(tempfile.mkdtemp(prefix='lwe-gnome-integration-'))
    print(f'Test artifacts: {directory}', flush=True)
    for name in ['data', 'config', 'cache', 'runtime', 'assets', 'wallpaper']:
        (directory / name).mkdir(mode=0o700)
    extension = directory / 'data/gnome-shell/extensions' / UUID
    shutil.copytree(ROOT / 'gnome-extension', extension)
    if args.blur_my_shell:
        shutil.copytree(args.blur_my_shell, extension.parent / BLUR_UUID)
    # Test instrumentation exists only in the temporary copy. The shipped bridge
    # does not export diagnostics or enable Shell's unsafe screenshot access.
    source = (extension / 'extension.js').read_text()
    source = source.replace('<method name="Register">',
        '<method name="TestState"><arg type="s" direction="out"/></method>'
        '<method name="TestAction"><arg type="s" direction="in"/></method><method name="Register">')
    source = source.replace('    _monitor(connector) {', '''    TestState() {
        global.context.unsafe_mode = true;
        const rect = r => [r.x, r.y, r.width, r.height];
        return JSON.stringify({ready: !Main.layoutManager._startingUp,
            overview: Main.overview.visible,
            blurMirrors: [...this._blurMyShell._widgets.values()].map(r => ({
                live: !!r.clone?.get_source(), effects: r.widget.get_effects().length,
            })),
            mirrors: [...this._overview._targets.values()].map(r => ({
                thumbnail: r.thumbnail, live: !!r.clone?.get_source(),
                monitor: r.thumbnail ? r.actor.monitorIndex : r.actor._monitorIndex,
                rect: [...r.actor.get_transformed_position(), ...r.actor.get_transformed_size()],
                sourceSize: r.source ? [r.source.get_width(), r.source.get_height()] : null,
                cloneSize: r.clone ? r.clone.get_transformed_size() : null,
            })),
            monitors: Main.layoutManager.monitors.map(rect),
            windows: [...this._windows.entries()].filter(([, r]) => r.registration).map(([w]) => ({
                type: w.get_window_type(), rect: rect(w.get_frame_rect()),
                skip: w.is_skip_taskbar(), sticky: w.is_on_all_workspaces(), focus: w.has_focus(),
            }))});
    }
    TestAction(action) {
        if (action === 'show') Main.overview.show();
        if (action === 'hide-cards' || action === 'show-cards') {
            for (const r of this._overview._targets.values()) r.actor.opacity = action === 'hide-cards' ? 0 : 255;
        }
        if (action === 'hide') Main.overview.hide();
        if (action === 'add-workspace') global.workspace_manager.append_new_workspace(false, global.get_current_time());
        if (action === 'change-background') {
            const settings = new Gio.Settings({schema_id: 'org.gnome.desktop.background'});
            settings.set_string('picture-uri', '');
            settings.set_string('picture-uri-dark', '');
        }
        if (action === 'switch-workspace') global.workspace_manager.get_workspace_by_index(1).activate(global.get_current_time());
    }
    _monitor(connector) {''')
    (extension / 'extension.js').write_text(source)
    (directory / 'wallpaper/project.json').write_text(json.dumps({
        'title': 'Bridge integration test', 'type': 'video', 'file': 'test.mp4',
    }))
    subprocess.run([ffmpeg, '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30',
        '-t', '2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', str(directory / 'wallpaper/test.mp4')], check=True)
    env = {**os.environ, 'LWE_TEST_FFMPEG': ffmpeg, 'LWE_TEST_BLUR_MY_SHELL': '1' if args.blur_my_shell else '0', **{f'XDG_{key}': str(directory / value) for key, value in {
        'DATA_HOME': 'data', 'CONFIG_HOME': 'config', 'CACHE_HOME': 'cache', 'RUNTIME_DIR': 'runtime',
    }.items()}}
    subprocess.run(['dbus-run-session', '--', sys.executable, str(Path(__file__).resolve()),
        '--inside', renderer, str(directory)], env=env, check=True)


if __name__ == '__main__':
    main()
