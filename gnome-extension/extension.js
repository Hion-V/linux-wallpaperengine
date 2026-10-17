import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {OverviewWallpapers} from './overview.js';
import {BlurMyShellWallpapers} from './blurMyShell.js';
import {WallpaperWorkspaceSpacing} from './workspaceSpacing.js';

const IFACE = `<node>
  <interface name="io.github.almamu.LinuxWallpaperEngine">
    <method name="GetPauseState">
      <arg name="paused" type="b" direction="out"/>
    </method>
    <method name="SubscribePauseState">
      <arg name="paused" type="b" direction="out"/>
    </method>
    <signal name="PauseStateChanged">
      <arg name="paused" type="b"/>
    </signal>
    <method name="Register">
      <arg name="connector" type="s" direction="in"/>
      <arg name="appId" type="s" direction="out"/>
    </method>
  </interface>
</node>`;
const PATH = '/org/gnome/Shell/Extensions/LinuxWallpaperEngine';

export default class WallpaperBridge extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._registrations = new Map();
        this._windows = new Map();
        this._unredirectInhibited = false;
        this._sources = new Map();
        this._rendererPids = new Set();
        this._fullscreenWindows = new Set();
        this._paused = false;
        this._pauseDirty = true;
        this._pauseUpdate = 0;
        const sourceForMonitor = index => this._sources.get(index) ?? null;
        this._overview = new OverviewWallpapers(sourceForMonitor);
        this._workspaceSpacing = new WallpaperWorkspaceSpacing(sourceForMonitor);
        this._blurMyShell = new BlurMyShellWallpapers(sourceForMonitor);
        this._cancellable = new Gio.Cancellable();
        this._bus = Gio.DBus.session;
        this._export = Gio.DBusExportedObject.wrapJSObject(IFACE, this);
        this._export.export(this._bus, PATH);
        this._readPauseSettings();
        this._settingsChanged = this._settings.connect('changed', () => {
            this._readPauseSettings();
            this._queuePauseUpdate();
        });
        this._workspaceChanged = global.workspace_manager.connect('active-workspace-changed', () =>
            this._queuePauseUpdate());
        this._overviewSignals = ['showing', 'hidden'].map(signal =>
            Main.overview.connect(signal, () => this._queuePauseUpdate()));
        this._created = global.display.connect('window-created', (_display, window) =>
            this._track(window));
        this._monitors = Main.layoutManager.connect('monitors-changed', () => {
            for (const [window, record] of this._windows) {
                if (record.registration)
                    this._place(window, record.registration);
            }
            this._refreshMirrors();
            this._queuePauseUpdate();
        });
        for (const actor of global.get_window_actors())
            this._track(actor.meta_window);
        this._updatePauseState(true);
    }

    // Resolve the bus sender's PID; clients cannot register another process's windows.
    RegisterAsync([connector], invocation) {
        if (this._monitor(connector) < 0) {
            invocation.return_dbus_error('io.github.almamu.InvalidOutput',
                `No Wayland monitor named ${connector}`);
            return;
        }
        const sender = invocation.get_sender();
        const cancellable = this._cancellable;
        this._bus.call('org.freedesktop.DBus', '/org/freedesktop/DBus',
            'org.freedesktop.DBus', 'GetConnectionUnixProcessID',
            new GLib.Variant('(s)', [sender]), new GLib.VariantType('(u)'),
            Gio.DBusCallFlags.NONE, 3000, cancellable, (bus, result) => {
                try {
                    const [pid] = bus.call_finish(result).deep_unpack();
                    if (cancellable.is_cancelled())
                        throw new Error('Bridge disabled');
                    const token = `io.github.almamu.wallpaper.${GLib.uuid_string_random()}`;
                    const registration = {pid, connector, window: null, watch: 0};
                    this._registrations.set(token, registration);
                    this._rendererPids.add(pid);
                    this._queuePauseUpdate();
                    registration.watch = Gio.bus_watch_name_on_connection(bus, sender,
                        Gio.BusNameWatcherFlags.NONE, null, () => this._revoke(token));
                    invocation.return_value(new GLib.Variant('(s)', [token]));
                } catch (error) {
                    invocation.return_dbus_error('io.github.almamu.RegistrationFailed', error.message);
                }
            });
    }

    _refreshMirrors() {
        this._sources.clear();
        for (const registration of this._registrations.values()) {
            const index = this._monitor(registration.connector);
            const source = registration.window?.get_compositor_private();
            if (index >= 0 && source && !this._sources.has(index))
                this._sources.set(index, source);
        }
        this._overview?.refresh();
        this._blurMyShell?.refresh();
    }

    _readPauseSettings() {
        this._pauseEnabled = this._settings.get_boolean('pause-on-fullscreen');
        this._whitelist = this._settings.get_string('filter-mode') === 'whitelist';
        this._classes = new Set(this._settings.get_strv(this._whitelist ? 'whitelist-window-classes' : 'window-classes')
            .map(value => value.trim().toLowerCase()).filter(Boolean));
    }

    _queuePauseUpdate() {
        this._pauseDirty = true;
        this._updateUnredirectInhibition();
        if (this._pauseUpdate)
            return;
        this._pauseUpdate = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._pauseUpdate = 0;
            this._updatePauseState();
            return GLib.SOURCE_REMOVE;
        });
    }

    _updatePauseState(force = false) {
        this._pauseDirty = false;
        const workspace = global.workspace_manager.get_active_workspace();
        const covered = new Set();
        let paused = false;
        for (const window of this._fullscreenWindows) {
            if (window.minimized || !window.located_on_workspace(workspace) ||
                this._rendererPids.has(window.get_pid()) ||
                [Meta.WindowType.DESKTOP, Meta.WindowType.DOCK].includes(window.get_window_type()))
                continue;
            const index = window.get_monitor();
            if (index >= 0) {
                const monitor = global.display.get_monitor_geometry(index);
                const frame = window.get_frame_rect();
                if (frame.x <= monitor.x && frame.y <= monitor.y &&
                    frame.x + frame.width >= monitor.x + monitor.width &&
                    frame.y + frame.height >= monitor.y + monitor.height)
                    covered.add(index);
            }
            const matches = [window.get_wm_class(), window.get_wm_class_instance()]
                .some(value => value && this._classes.has(value.toLowerCase()));
            paused ||= this._whitelist ? matches : !matches;
        }
        paused = this._pauseEnabled && !Main.overview.visible && paused;
        this._coveredMonitors = covered;
        const changed = paused !== this._paused;
        this._paused = paused;
        this._updateUnredirectInhibition();
        if (changed || force)
            this._export.emit_signal('PauseStateChanged', new GLib.Variant('(b)', [paused]));
    }

    GetPauseState() {
        if (this._pauseDirty) {
            if (this._pauseUpdate)
                GLib.Source.remove(this._pauseUpdate);
            this._pauseUpdate = 0;
            this._updatePauseState();
        }
        return this._paused;
    }

    // Clients install their signal match before requesting this initial state.
    // A separate handshake lets new renderers detect older extensions safely.
    SubscribePauseState() { return this.GetPauseState(); }

    _monitor(connector) {
        return global.backend.get_monitor_manager().get_monitor_for_connector(connector);
    }

    _track(window) {
        if (this._windows.has(window))
            return;
        const record = {registration: null, signals: []};
        this._windows.set(window, record);
        const update = () => {
            if (window.is_fullscreen()) this._fullscreenWindows.add(window);
            else this._fullscreenWindows.delete(window);
            this._queuePauseUpdate();
        };
        record.signals.push(window.connect('notify::wm-class', () => {
            this._consider(window);
            update();
        }));
        for (const signal of ['notify::fullscreen', 'notify::minimized', 'notify::window-type',
            'notify::on-all-workspaces', 'workspace-changed'])
            record.signals.push(window.connect(signal, update));
        for (const signal of ['notify::main-monitor', 'position-changed', 'size-changed'])
            record.signals.push(window.connect(signal, () => {
                if (this._fullscreenWindows.has(window)) this._queuePauseUpdate();
            }));
        record.signals.push(window.connect('unmanaged', () => {
            this._windows.delete(window);
            this._fullscreenWindows.delete(window);
            this._queuePauseUpdate();
            for (const signal of record.signals)
                window.disconnect(signal);
            if (record.registration)
                this._revoke(record.token, false);
        }));
        this._consider(window);
        update();
    }

    _consider(window) {
        const record = this._windows.get(window);
        if (!record || record.registration)
            return;
        const token = window.get_wm_class();
        const registration = this._registrations.get(token);
        if (!registration || registration.window || window.get_pid() !== registration.pid ||
            window.get_client_type() !== Meta.WindowClientType.WAYLAND)
            return;
        record.registration = registration;
        record.token = token;
        registration.window = window;
        // Mutter owns desktop stacking and workspace visibility. Overview actors
        // mirror this surface without moving it out of Mutter's window group.
        window.set_type(Meta.WindowType.DESKTOP);
        window.hide_from_window_list();
        window.stick();
        // Shell hides its panel when Mutter considers the primary monitor
        // fullscreen. A monitor-sized xdg-toplevel must remain a desktop even
        // when pointer focus moves to a window on another monitor.
        record.signals.push(window.connect('notify::fullscreen', () => {
            if (window.is_fullscreen())
                window.unmake_fullscreen();
        }));
        if (window.is_fullscreen())
            window.unmake_fullscreen();
        this._updateUnredirectInhibition();
        this._place(window, registration);
        window.lower();
        this._refreshMirrors();
        record.signals.push(window.connect('shown', () => {
            this._place(window, registration);
            window.lower();
            this._refreshMirrors();
        }));
    }

    _updateUnredirectInhibition() {
        const windows = [...this._registrations.values()].filter(r => r.window !== null);
        // Keep the scanout workaround while any wallpaper is exposed. A paused
        // wallpaper on another monitor still needs this protection.
        const fullyCovered = !this._pauseDirty && this._paused && !Main.overview.visible && windows.every(r =>
            this._coveredMonitors?.has(this._monitor(r.connector)));
        const shouldInhibit = windows.length > 0 && !fullyCovered;
        if (shouldInhibit === this._unredirectInhibited)
            return;
        this._unredirectInhibited = shouldInhibit;
        if (shouldInhibit)
            global.compositor.disable_unredirect();
        else
            global.compositor.enable_unredirect();
    }

    _place(window, registration) {
        const index = this._monitor(registration.connector);
        if (index < 0) {
            window.delete(global.get_current_time());
            return;
        }
        const {x, y, width, height} = global.display.get_monitor_geometry(index);
        // Workspace/overview visibility changes must not reconfigure an already
        // correctly placed surface: keep the last buffer available to clones.
        if (window.get_monitor() !== index)
            window.move_to_monitor(index);
        const frame = window.get_frame_rect();
        if (frame.x !== x || frame.y !== y || frame.width !== width || frame.height !== height)
            window.move_resize_frame(false, x, y, width, height);
    }

    _revoke(token, close = true) {
        const registration = this._registrations.get(token);
        if (!registration)
            return;
        this._registrations.delete(token);
        this._rendererPids = new Set([...this._registrations.values()].map(r => r.pid));
        this._queuePauseUpdate();
        this._updateUnredirectInhibition();
        this._refreshMirrors();
        Gio.bus_unwatch_name(registration.watch);
        if (close && registration.window)
            registration.window.delete(global.get_current_time());
    }

    disable() {
        // Resume existing clients before removing the exported interface.
        this._export.emit_signal('PauseStateChanged', new GLib.Variant('(b)', [false]));
        this._settings.disconnect(this._settingsChanged);
        global.workspace_manager.disconnect(this._workspaceChanged);
        for (const id of this._overviewSignals)
            Main.overview.disconnect(id);
        this._workspaceSpacing.destroy();
        this._workspaceSpacing = null;
        this._blurMyShell.destroy();
        this._blurMyShell = null;
        this._overview.destroy();
        this._overview = null;
        this._cancellable.cancel();
        this._export.unexport();
        global.display.disconnect(this._created);
        Main.layoutManager.disconnect(this._monitors);
        for (const [window, record] of this._windows) {
            for (const signal of record.signals)
                window.disconnect(signal);
        }
        this._windows.clear();
        for (const token of this._registrations.keys())
            this._revoke(token);
        if (this._pauseUpdate)
            GLib.Source.remove(this._pauseUpdate);
        this._pauseUpdate = 0;
        this._sources.clear();
        this._fullscreenWindows.clear();
        this._export = null;
        this._cancellable = null;
        this._bus = null;
        this._settings = null;
        this._unredirectInhibited = false;
    }
}
