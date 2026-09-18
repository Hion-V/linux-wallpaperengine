import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

class Widget {
    signals = new Map();
    children = [];
    next = 0;
    constructor(props = {}) { Object.assign(this, props); }
    add(child) { this.children.push(child); }
    connect(name, callback) { this.signals.set(++this.next, [name, callback]); return this.next; }
    disconnect(id) { this.signals.delete(id); }
    emit(name) {
        for (const [signal, fn] of this.signals.values()) if (name === signal) fn();
    }
    set selected(value) {
        if (this._selected === value) return;
        this._selected = value;
        this.emit('notify::selected');
    }
    get selected() { return this._selected; }
}

function setup() {
    const settings = new Widget();
    const values = {'filter-mode': 'blacklist', 'window-classes': ['firefox'], 'whitelist-window-classes': [], 'pause-on-fullscreen': true};
    Object.assign(settings, {
        get_string: key => values[key], get_strv: key => values[key],
        set_string(key, value) {
            if (values[key] === value) return;
            values[key] = value;
            this.emit(`changed::${key}`);
        },
        set_strv(key, value) { values[key] = [...value]; this.emit(`changed::${key}`); },
        bind(key, widget, property) {
            widget[property] = values[key];
            widget.connect(`notify::${property}`, () => { values[key] = widget[property]; });
        },
    });
    const context = vm.createContext({
        Adw: Object.fromEntries(['PreferencesPage', 'PreferencesGroup', 'SwitchRow', 'ComboRow', 'EntryRow', 'ActionRow'].map(k => [k, Widget])),
        Gtk: {StringList: {new: values => values}}, Gio: {SettingsBindFlags: {DEFAULT: 0}},
        ExtensionPreferences: class { getSettings() { return settings; } },
    });
    const source = readFileSync(new URL('../gnome-extension/prefs.js', import.meta.url), 'utf8')
        .replace(/^import .*;\n/gm, '').replace('export default class', 'class');
    const prefs = vm.runInContext(`${source}\nnew WallpaperPreferences()`, context);
    const window = new Widget();
    prefs.fillPreferencesWindow(window);
    const [enabled, mode, classes] = window.children[0].children[0].children;
    return {window, settings, values, enabled, mode, classes};
}

test('preferences toggle, preserve filter list across modes, and apply trimmed entries', () => {
    const {enabled, mode, classes, values} = setup();
    enabled.active = false;
    enabled.emit('notify::active');
    assert.equal(values['pause-on-fullscreen'], false);
    mode.selected = 1;
    assert.equal(values['filter-mode'], 'whitelist');
    assert.deepEqual(values['window-classes'], ['firefox']);
    classes.text = ' org.gnome.Terminal, firefox, ,firefox ';
    classes.emit('apply');
    assert.deepEqual(values['whitelist-window-classes'], ['org.gnome.Terminal', 'firefox']);
    mode.selected = 0;
    assert.equal(classes.text, 'firefox');
    mode.selected = 1;
    assert.equal(classes.text, 'org.gnome.Terminal, firefox');
    classes.text = '';
    classes.emit('apply');
    assert.deepEqual(values['whitelist-window-classes'], []);
    assert.deepEqual(values['window-classes'], ['firefox']);
});

test('external settings changes update preferences and handlers are released on close', () => {
    const {window, settings, mode, classes} = setup();
    settings.set_string('filter-mode', 'whitelist');
    assert.equal(mode.selected, 1);
    settings.set_strv('whitelist-window-classes', ['game']);
    assert.equal(classes.text, 'game');
    window.emit('close-request');
    assert.equal(settings.signals.size, 0);
});

test('the mode control persists both directions with the same app in both lists', () => {
    const {settings, values, mode, classes} = setup();
    settings.set_strv('whitelist-window-classes', ['firefox']);
    mode.selected = 1;
    assert.equal(values['filter-mode'], 'whitelist');
    assert.equal(classes.text, 'firefox');
    mode.selected = 0;
    assert.equal(values['filter-mode'], 'blacklist');
    mode.selected = 1;
    assert.equal(values['filter-mode'], 'whitelist');
    assert.deepEqual(values['window-classes'], ['firefox']);
    assert.deepEqual(values['whitelist-window-classes'], ['firefox']);
});
