// Run with node --test tests/gnome-bridge.mjs. Mock Shell's boundary, not its internals.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

class Signals {
    handlers = new Map();
    next = 0;
    connect(name, callback) { this.handlers.set(++this.next, [name, callback]); return this.next; }
    disconnect(id) { this.handlers.delete(id); }
    emit(name, ...args) {
        for (const [signal, callback] of [...this.handlers.values()])
            if (signal === name) callback(this, ...args);
    }
}
function setup() {
    const watches = new Map();
    let next = 0;
    const display = new Signals();
    display.get_monitor_geometry = () => ({x: -1280, y: 0, width: 1280, height: 720});
    const layout = new Signals();
    const manager = {get_monitor_for_connector: c => c === 'DP-1' ? 0 : -1};
    const bus = {
        call(_a, _b, _c, _d, _e, _f, _g, _h, _i, callback) { callback(this, {}); },
        call_finish() { return {deep_unpack: () => [123]}; },
    };
    const context = vm.createContext({
        Gio: {
            Cancellable: class { cancel() { this.cancelled = true; } is_cancelled() { return !!this.cancelled; } },
            DBus: {session: bus}, DBusCallFlags: {NONE: 0}, BusNameWatcherFlags: {NONE: 0},
            DBusExportedObject: {wrapJSObject: () => ({export() {}, unexport() {}})},
            bus_watch_name_on_connection(_a, _b, _c, _d, vanished) { watches.set(++next, vanished); return next; },
            bus_unwatch_name(id) { watches.delete(id); },
        },
        GLib: {Variant: class { constructor(type, value) { this.value = value; } },
            VariantType: class {}, uuid_string_random: () => String(++next)},
        Meta: {is_wayland_compositor: () => true, WindowType: {DESKTOP: 1}, WindowClientType: {WAYLAND: 1}},
        BlurMyShellWallpapers: class { refresh() {} destroy() {} },
        OverviewWallpapers: class { refresh() {} destroy() {} },
        Extension: class {}, Main: {layoutManager: layout},
        global: {display, backend: {get_monitor_manager: () => manager}, get_current_time: () => 0},
    });
    const source = readFileSync(new URL('../gnome-extension/extension.js', import.meta.url), 'utf8')
        .replace(/^import .*;\n/gm, '').replace('export default class WallpaperBridge', 'class WallpaperBridge');
    const bridge = vm.runInContext(`${source}\nnew WallpaperBridge()`, context);
    bridge.enable();
    function register(connector = 'DP-1') {
        let token, error;
        bridge.RegisterAsync([connector], {get_sender: () => ':1.23',
            return_value: v => { [token] = v.value; }, return_dbus_error: (...args) => { error = args; }});
        return {token, error};
    }
    function window(token, pid = 123) {
        const w = new Signals();
        Object.assign(w, {get_wm_class: () => token, get_pid: () => pid, get_client_type: () => 1,
            set_type(t) { this.type = t; }, hide_from_window_list() { this.hidden = true; },
            stick() { this.sticky = true; }, move_to_monitor(i) { this.monitor = i; },
            move_resize_frame(_user, ...rect) { this.rect = rect; }, lower() { this.lowered = true; },
            is_fullscreen() { return !!this.fullscreen; },
            unmake_fullscreen() { this.fullscreen = false; this.unfullscreened = true; },
            delete() { this.closed = true; }});
        display.emit('window-created', w);
        return w;
    }
    return {bridge, watches, display, layout, manager, register, window};
}

test('registered Wayland window becomes a desktop on its full monitor', () => {
    const t = setup();
    const {token} = t.register();
    const w = t.window(token);
    assert.equal(w.type, 1);
    assert.ok(w.hidden && w.sticky && w.lowered);
    assert.deepEqual(w.rect, [-1280, 0, 1280, 720]);
    t.bridge.disable();
    assert.ok(w.closed);
    assert.equal(t.watches.size, 0);
    assert.equal(w.handlers.size, 0);
    assert.equal(t.display.handlers.size, 0);
    assert.equal(t.layout.handlers.size, 0);
});
test('wallpaper cannot retain fullscreen state and hide Shell chrome', () => {
    const t = setup();
    const w = t.window(t.register().token);
    w.fullscreen = true;
    w.emit('notify::fullscreen');
    assert.equal(w.fullscreen, false);
    assert.equal(w.unfullscreened, true);
    t.bridge.disable();
});
test('rejects unknown connectors, foreign PIDs, unknown tokens and token reuse', () => {
    const t = setup();
    assert.ok(t.register('missing').error);
    const {token} = t.register();
    assert.equal(t.window(token, 999).type, undefined);
    assert.equal(t.window('unregistered').type, undefined);
    assert.equal(t.window(token).type, 1);
    assert.equal(t.window(token).type, undefined);
    t.bridge.disable();
});
test('bus disconnect closes the associated window and removes registration', () => {
    const t = setup();
    const {token} = t.register();
    const w = t.window(token);
    [...t.watches.values()][0]();
    assert.ok(w.closed);
    assert.equal(t.bridge._registrations.size, 0);
    w.emit('unmanaged');
    assert.equal(w.handlers.size, 0);
    t.bridge.disable();
});
test('unmapping cleans up, and disconnected monitors close their wallpaper', () => {
    const t = setup();
    const w = t.window(t.register().token);
    w.emit('unmanaged');
    assert.equal(t.watches.size, 0);
    const other = t.window(t.register().token);
    t.manager.get_monitor_for_connector = () => -1;
    t.layout.emit('monitors-changed');
    assert.ok(other.closed);
    t.bridge.disable();
});
