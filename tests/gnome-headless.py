#!/usr/bin/env python3
"""Integration test against an installed GNOME 50, in a private D-Bus session.

Usage: python3 tests/gnome-headless.py /path/to/linux-wallpaperengine /path/to/ffmpeg
Requires gnome-shell, dconf, gdbus and dbus-run-session on PATH. Uses temporary
XDG directories, two virtual monitors, and a generated video (no Steam assets).
"""
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
    subprocess.run(['dconf', 'load', '/'], input=f'''[org/gnome/shell]
enabled-extensions=['{UUID}']
disable-user-extensions=false
welcome-dialog-last-shown-version='50.4'
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
    if len(sys.argv) != 3:
        raise SystemExit(__doc__)
    renderer, ffmpeg = map(os.path.abspath, sys.argv[1:])
    directory = Path(tempfile.mkdtemp(prefix='lwe-gnome-integration-'))
    print(f'Test artifacts: {directory}', flush=True)
    for name in ['data', 'config', 'cache', 'runtime', 'assets', 'wallpaper']:
        (directory / name).mkdir(mode=0o700)
    extension = directory / 'data/gnome-shell/extensions' / UUID
    shutil.copytree(ROOT / 'gnome-extension', extension)
    # Test instrumentation exists only in the temporary copy. The shipped bridge
    # does not export diagnostics or enable Shell's unsafe screenshot access.
    source = (extension / 'extension.js').read_text()
    source = source.replace('<method name="Register">',
        '<method name="TestState"><arg type="s" direction="out"/></method><method name="Register">')
    source = source.replace('    _monitor(connector) {', '''    TestState() {
        global.context.unsafe_mode = true;
        Main.overview.hide();
        const rect = r => [r.x, r.y, r.width, r.height];
        return JSON.stringify({ready: !Main.layoutManager._startingUp,
            monitors: Main.layoutManager.monitors.map(rect),
            windows: [...this._windows.entries()].filter(([, r]) => r.registration).map(([w]) => ({
                type: w.get_window_type(), rect: rect(w.get_frame_rect()),
                skip: w.is_skip_taskbar(), sticky: w.is_on_all_workspaces(), focus: w.has_focus(),
            }))});
    }
    _monitor(connector) {''')
    (extension / 'extension.js').write_text(source)
    (directory / 'wallpaper/project.json').write_text(json.dumps({
        'title': 'Bridge integration test', 'type': 'video', 'file': 'test.mp4',
    }))
    subprocess.run([ffmpeg, '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30',
        '-t', '2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', str(directory / 'wallpaper/test.mp4')], check=True)
    env = {**os.environ, **{f'XDG_{key}': str(directory / value) for key, value in {
        'DATA_HOME': 'data', 'CONFIG_HOME': 'config', 'CACHE_HOME': 'cache', 'RUNTIME_DIR': 'runtime',
    }.items()}}
    subprocess.run(['dbus-run-session', '--', sys.executable, str(Path(__file__).resolve()),
        '--inside', renderer, str(directory)], env=env, check=True)


if __name__ == '__main__':
    main()
