import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {OverviewWallpapers} from './overview.js';
import {BlurMyShellWallpapers} from './blurMyShell.js';

const IFACE = `<node>
  <interface name="io.github.almamu.LinuxWallpaperEngine">
    <method name="GetPauseState">
      <arg name="paused" type="b" direction="out"/>
    </method>
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
        const sourceForMonitor = index => {
            for (const registration of this._registrations.values()) {
                if (registration.window && this._monitor(registration.connector) === index)
                    return registration.window.get_compositor_private();
            }
            return null;
        };
        this._overview = new OverviewWallpapers(sourceForMonitor);
        this._blurMyShell = new BlurMyShellWallpapers(sourceForMonitor);
        this._cancellable = new Gio.Cancellable();
        this._bus = Gio.DBus.session;
        this._export = Gio.DBusExportedObject.wrapJSObject(IFACE, this);
        this._export.export(this._bus, PATH);
        this._created = global.display.connect('window-created', (_display, window) =>
            this._track(window));
        this._monitors = Main.layoutManager.connect('monitors-changed', () => {
            for (const [window, record] of this._windows) {
                if (record.registration)
                    this._place(window, record.registration);
            }
            this._refreshMirrors();
        });
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
                    registration.watch = Gio.bus_watch_name_on_connection(bus, sender,
                        Gio.BusNameWatcherFlags.NONE, null, () => this._revoke(token));
                    invocation.return_value(new GLib.Variant('(s)', [token]));
                } catch (error) {
                    invocation.return_dbus_error('io.github.almamu.RegistrationFailed', error.message);
                }
            });
    }

    _refreshMirrors() {
        this._overview?.refresh();
        this._blurMyShell?.refresh();
    }

    GetPauseState() {
        if (!this._settings.get_boolean('pause-on-fullscreen') || Main.overview.visible)
            return false;
        const whitelist = this._settings.get_string('filter-mode') === 'whitelist';
        const classes = new Set(this._settings.get_strv(whitelist ? 'whitelist-window-classes' : 'window-classes')
            .map(value => value.trim().toLowerCase()).filter(Boolean));
        const workspace = global.workspace_manager.get_active_workspace();
        const rendererPids = new Set([...this._registrations.values()].map(r => r.pid));
        return global.get_window_actors().some(actor => {
            const window = actor.meta_window;
            if (!window.is_fullscreen() || window.minimized ||
                !window.located_on_workspace(workspace) || rendererPids.has(window.get_pid()) ||
                [Meta.WindowType.DESKTOP, Meta.WindowType.DOCK].includes(window.get_window_type()))
                return false;
            const matches = [window.get_wm_class(), window.get_wm_class_instance()]
                .some(value => value && classes.has(value.toLowerCase()));
            return whitelist ? matches : !matches;
        });
    }

    _monitor(connector) {
        return global.backend.get_monitor_manager().get_monitor_for_connector(connector);
    }

    _track(window) {
        const record = {registration: null, signals: []};
        this._windows.set(window, record);
        record.signals.push(window.connect('notify::wm-class', () => this._consider(window)));
        record.signals.push(window.connect('unmanaged', () => {
            this._windows.delete(window);
            for (const signal of record.signals)
                window.disconnect(signal);
            if (record.registration)
                this._revoke(record.token, false);
        }));
        this._consider(window);
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
        this._place(window, registration);
        window.lower();
        this._refreshMirrors();
        record.signals.push(window.connect('shown', () => {
            this._place(window, registration);
            window.lower();
            this._refreshMirrors();
        }));
    }

    _place(window, registration) {
        const index = this._monitor(registration.connector);
        if (index < 0) {
            window.delete(global.get_current_time());
            return;
        }
        const {x, y, width, height} = global.display.get_monitor_geometry(index);
        window.move_to_monitor(index);
        window.move_resize_frame(false, x, y, width, height);
    }

    _revoke(token, close = true) {
        const registration = this._registrations.get(token);
        if (!registration)
            return;
        this._registrations.delete(token);
        this._refreshMirrors();
        Gio.bus_unwatch_name(registration.watch);
        if (close && registration.window)
            registration.window.delete(global.get_current_time());
    }

    disable() {
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
        this._export = null;
        this._cancellable = null;
        this._bus = null;
        this._settings = null;
    }
}
