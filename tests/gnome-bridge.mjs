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
    const pending = new Map();
    const pauseSignals = [];
    let next = 0;
    const settings = new Signals();
    Object.assign(settings, {get_boolean() { return this.enabled; }, get_string() { return this.mode; },
        get_strv(key) { return key === 'whitelist-window-classes' ? this.whitelist : this.classes; }});
    for (const [key, initial] of Object.entries({enabled: true, mode: 'blacklist', classes: [], whitelist: []})) {
        let value = initial;
        Object.defineProperty(settings, key, {get: () => value, set(v) { value = v; settings.emit('changed'); }});
    }
    const actors = [];
    const overview = new Signals();
    let visible = false;
    Object.defineProperty(overview, 'visible', {get: () => visible,
        set(v) { visible = v; overview.emit(v ? 'showing' : 'hidden'); }});
    const workspaceManager = new Signals();
    workspaceManager.get_active_workspace = () => 0;
    const display = new Signals();
    display.get_monitor_geometry = () => ({x: -1280, y: 0, width: 1280, height: 720});
    const layout = new Signals();
    const manager = {get_monitor_for_connector: c => c === 'DP-1' ? 0 : -1};
    const bus = {
        call(_a, _b, _c, _d, _e, _f, _g, _h, _i, callback) { callback(this, {}); },
        call_finish() { return {deep_unpack: () => [123]}; },
    };
    const compositor = {
        inhibited: 0,
        disable_unredirect() { this.inhibited++; },
        enable_unredirect() { this.inhibited--; },
    };
    const context = vm.createContext({
        Gio: {
            Cancellable: class { cancel() { this.cancelled = true; } is_cancelled() { return !!this.cancelled; } },
            DBus: {session: bus}, DBusCallFlags: {NONE: 0}, BusNameWatcherFlags: {NONE: 0},
            DBusExportedObject: {wrapJSObject: () => ({export() {}, unexport() {}, emit_signal(name, v) { pauseSignals.push([name, ...v.value]); }})},
            bus_watch_name_on_connection(_a, _b, _c, _d, vanished) { watches.set(++next, vanished); return next; },
            bus_unwatch_name(id) { watches.delete(id); },
        },
        GLib: {Variant: class { constructor(type, value) { this.value = value; } },
            VariantType: class {}, uuid_string_random: () => String(++next),
            PRIORITY_DEFAULT_IDLE: 0, SOURCE_REMOVE: false,
            idle_add(_priority, callback) { pending.set(++next, callback); return next; },
            Source: {remove(id) { pending.delete(id); }}},
        Meta: {is_wayland_compositor: () => true, WindowType: {DESKTOP: 1}, WindowClientType: {WAYLAND: 1}},
        BlurMyShellWallpapers: class { refresh() {} destroy() {} },
        OverviewWallpapers: class { refresh() {} destroy() {} },
        WallpaperWorkspaceSpacing: class { destroy() {} },
        Extension: class { getSettings() { return settings; } }, Main: {layoutManager: layout, overview},
        global: {display, compositor, get_window_actors: () => actors, workspace_manager: workspaceManager, backend: {get_monitor_manager: () => manager}, get_current_time: () => 0},
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
        w.actor = {children: [], add_child(child) { this.children.push(child); }};
        Object.assign(w, {get_compositor_private: () => w.actor, get_wm_class: () => token, get_pid: () => pid, get_client_type: () => 1,
            set_type(t) { this.type = t; }, hide_from_window_list() { this.hidden = true; },
            stick() { this.sticky = true; },
            get_monitor() { return this.monitor ?? -1; },
            get_frame_rect() { const [x, y, width, height] = this.rect ?? [0, 0, 0, 0]; return {x, y, width, height}; },
            move_to_monitor(i) { this.monitor = i; this.monitorMoves = (this.monitorMoves ?? 0) + 1; },
            move_resize_frame(_user, ...rect) { this.rect = rect; this.resizes = (this.resizes ?? 0) + 1; }, lower() { this.lowered = true; },
            is_fullscreen() { return !!this.fullscreen; },
            minimized: false, located_on_workspace: () => true,
            get_window_type() { return this.type ?? 0; }, get_wm_class_instance: () => null,
            unmake_fullscreen() { this.fullscreen = false; this.unfullscreened = true; },
            delete() { this.closed = true; }});
        actors.push({meta_window: w});
        display.emit('window-created', w);
        return w;
    }
    function flush() {
        for (let rounds = 0; pending.size; rounds++) {
            assert.ok(rounds < 10);
            const callbacks = [...pending.values()]; pending.clear();
            callbacks.forEach(fn => fn());
        }
    }
    return {bridge, watches, display, layout, manager, register, window, settings, actors, overview, compositor,
        flush, pending, pauseSignals, workspaceManager};
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

function fullscreen(t, appId, options = {}) {
    const w = t.window(appId, 456);
    Object.assign(w, {is_fullscreen: () => true, get_monitor: () => 0, ...options});
    const geometry = t.display.get_monitor_geometry(w.get_monitor());
    w.rect = [geometry.x, geometry.y, geometry.width, geometry.height];
    w.emit('notify::fullscreen');
    return w;
}
test('fullscreen pauses globally; toggle and overview resume immediately', () => {
    const t = setup();
    assert.equal(t.bridge.GetPauseState(), false);
    fullscreen(t, 'game');
    assert.equal(t.bridge.GetPauseState(), true);
    t.settings.enabled = false;
    assert.equal(t.bridge.GetPauseState(), false);
    t.settings.enabled = true;
    t.overview.visible = true;
    assert.equal(t.bridge.GetPauseState(), false);
    t.overview.visible = false;
    assert.equal(t.bridge.GetPauseState(), true);
});
test('blacklist ignores matching classes but another fullscreen app still pauses', () => {
    const t = setup();
    t.settings.classes = [' GAME '];
    fullscreen(t, 'game');
    assert.equal(t.bridge.GetPauseState(), false);
    fullscreen(t, 'other-game');
    assert.equal(t.bridge.GetPauseState(), true);
});
test('whitelist pauses only exact matching classes or class instances', () => {
    const t = setup();
    t.settings.mode = 'whitelist';
    fullscreen(t, 'game');
    assert.equal(t.bridge.GetPauseState(), false);
    t.settings.whitelist = ['gam'];
    assert.equal(t.bridge.GetPauseState(), false);
    t.settings.whitelist = ['GAME'];
    assert.equal(t.bridge.GetPauseState(), true);
    t.settings.whitelist = ['instance'];
    fullscreen(t, null, {get_wm_class_instance: () => 'Instance'});
    assert.equal(t.bridge.GetPauseState(), true);
});
test('hidden, other-workspace, desktop and registered renderer windows never pause', () => {
    const t = setup();
    t.register();
    fullscreen(t, 'minimized', {minimized: true});
    fullscreen(t, 'elsewhere', {located_on_workspace: () => false});
    fullscreen(t, 'desktop', {get_window_type: () => 1});
    fullscreen(t, 'renderer', {get_pid: () => 123});
    fullscreen(t, 'normal', {is_fullscreen: () => false});
    assert.equal(t.bridge.GetPauseState(), false);
});

test('switching modes uses only the selected list, including overlapping entries', () => {
    const t = setup();
    t.settings.classes = ['browser'];
    t.settings.whitelist = ['game'];
    const window = fullscreen(t, 'browser');
    assert.equal(t.bridge.GetPauseState(), false);
    t.settings.mode = 'whitelist';
    assert.equal(t.bridge.GetPauseState(), false, 'blacklist-only app must not trigger whitelist');
    window.get_wm_class = () => 'game';
    window.emit('notify::wm-class');
    assert.equal(t.bridge.GetPauseState(), true);
    t.settings.classes = ['game'];
    assert.equal(t.bridge.GetPauseState(), true, 'blacklist must not veto a whitelist match');
    t.settings.mode = 'blacklist';
    assert.equal(t.bridge.GetPauseState(), false);
    t.settings.mode = 'whitelist';
    t.settings.whitelist = [];
    assert.equal(t.bridge.GetPauseState(), false, 'empty whitelist must not fall back to blacklist');
});

test('registered wallpapers inhibit unredirect without mutating window actor children', () => {
    const t = setup();
    const ordinary = t.window('ordinary', 999);
    assert.equal(ordinary.actor.children.length, 0);
    const first = t.window(t.register().token);
    assert.equal(first.actor.children.length, 0);
    assert.equal(t.compositor.inhibited, 1);
    const second = t.window(t.register().token);
    assert.equal(second.actor.children.length, 0);
    assert.equal(t.compositor.inhibited, 1, 'one bridge-level inhibitor covers every wallpaper');
    first.emit('unmanaged');
    assert.equal(t.compositor.inhibited, 1, 'remaining wallpaper keeps composition enabled');
    t.bridge.disable();
    assert.equal(t.compositor.inhibited, 0);
});

test('workspace visibility changes preserve geometry without repeated configure requests', () => {
    const t = setup();
    const wallpaper = t.window(t.register().token);
    for (let i = 0; i < 5; i++) wallpaper.emit('shown');
    assert.equal(wallpaper.monitorMoves, 1);
    assert.equal(wallpaper.resizes, 1);
    wallpaper.rect = [0, 0, 640, 480];
    wallpaper.emit('shown');
    assert.equal(wallpaper.resizes, 2);
    assert.deepEqual(wallpaper.rect, [-1280, 0, 1280, 720]);
    t.bridge.disable();
});

test('pause reads are cached; change signals are coalesced and emitted only on transitions', () => {
    const t = setup();
    let scans = 0;
    t.workspaceManager.get_active_workspace = () => { scans++; return 0; };
    for (let i = 0; i < 20; i++) assert.equal(t.bridge.GetPauseState(), false);
    assert.equal(scans, 0);
    const game = fullscreen(t, 'game');
    game.emit('notify::fullscreen');
    game.emit('notify::minimized');
    assert.equal(t.pending.size, 1);
    t.flush();
    assert.equal(scans, 1);
    assert.equal(t.bridge.SubscribePauseState(), true);
    const signals = t.pauseSignals.length;
    for (let i = 0; i < 20; i++) assert.equal(t.bridge.GetPauseState(), true);
    assert.equal(scans, 1);
    game.emit('notify::fullscreen'); t.flush();
    assert.equal(t.pauseSignals.length, signals);
    game.minimized = true; game.emit('notify::minimized'); t.flush();
    assert.deepEqual(t.pauseSignals.at(-1), ['PauseStateChanged', false]);
    game.minimized = false; game.emit('notify::minimized'); t.flush();
    assert.deepEqual(t.pauseSignals.at(-1), ['PauseStateChanged', true]);
    game.located_on_workspace = () => false;
    t.workspaceManager.emit('active-workspace-changed'); t.flush();
    assert.equal(t.bridge.GetPauseState(), false);
    t.bridge.disable();
    assert.equal(t.pending.size, 0);
    assert.equal(t.workspaceManager.handlers.size, 0);
    assert.equal(t.settings.handlers.size, 0);
    assert.equal(t.overview.handlers.size, 0);
});

test('scanout is released only when paused fullscreen windows cover every wallpaper output', () => {
    const t = setup();
    t.manager.get_monitor_for_connector = c => c === 'DP-1' ? 0 : c === 'DP-2' ? 1 : -1;
    t.window(t.register('DP-1').token);
    t.window(t.register('DP-2').token);
    const first = fullscreen(t, 'game', {get_monitor: () => 0});
    t.flush();
    assert.equal(t.bridge.GetPauseState(), true);
    assert.equal(t.compositor.inhibited, 1, 'exposed second wallpaper remains protected');
    const second = fullscreen(t, 'game2', {get_monitor: () => 1}); t.flush();
    assert.equal(t.compositor.inhibited, 0);
    t.overview.visible = true;
    assert.equal(t.compositor.inhibited, 1, 'Activities restores protection immediately');
    t.flush();
    assert.equal(t.bridge.GetPauseState(), false);
    t.overview.visible = false; t.flush();
    assert.equal(t.compositor.inhibited, 0);
    second.minimized = true; second.emit('notify::minimized');
    assert.equal(t.compositor.inhibited, 1, 'uncovering a wallpaper protects it before the idle update');
    t.flush();
    first.emit('unmanaged'); t.flush();
    assert.equal(t.bridge.GetPauseState(), false);
    t.bridge.disable();
    assert.equal(t.compositor.inhibited, 0);
});

test('disabling pause preserves compositing protection even with complete fullscreen coverage', () => {
    const t = setup();
    t.window(t.register().token);
    fullscreen(t, 'game'); t.flush();
    assert.equal(t.compositor.inhibited, 0);
    t.settings.enabled = false; t.flush();
    assert.equal(t.compositor.inhibited, 1);
    t.bridge.disable();
    assert.equal(t.compositor.inhibited, 0);
});


test('a fullscreen flag alone cannot release scanout before the window covers the output', () => {
    const t = setup();
    t.window(t.register().token);
    const game = fullscreen(t, 'game');
    game.rect = [-1280, 0, 640, 720]; game.emit('size-changed'); t.flush();
    assert.equal(t.bridge.GetPauseState(), true);
    assert.equal(t.compositor.inhibited, 1);
    game.rect = [-1280, 0, 1280, 720]; game.emit('size-changed'); t.flush();
    assert.equal(t.compositor.inhibited, 0);
    game.rect = [-1280, 0, 640, 720]; game.emit('size-changed');
    assert.equal(t.compositor.inhibited, 1);
    t.bridge.disable();
});
