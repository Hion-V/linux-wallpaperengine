import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

class Actor {
    constructor(properties = {}) {
        Object.assign(this, properties);
        this.children = [];
        this.signals = new Map();
        this.next = 0;
    }
    connect(name, callback) { this.signals.set(++this.next, [name, callback]); return this.next; }
    disconnect(id) { this.signals.delete(id); }
    emit(name, child) {
        for (const [signal, callback] of [...this.signals.values()])
            if (signal === name) callback(this, child);
    }
    get_children() { return [...this.children]; }
    add_child(child) { this.children.push(child); child.parent = this; this.emit('child-added', child); }
    remove_child(child) {
        this.children.splice(this.children.indexOf(child), 1);
        child.parent = null;
        this.emit('child-removed', child);
    }
    set_child_above_sibling(child) {
        this.children.splice(this.children.indexOf(child), 1);
        this.children.push(child);
    }
    set_position(x, y) { this.position = [x, y]; }
    set_size(w, h) { this.size = [w, h]; }
    destroy() {
        this.emit('destroy');
        this.destroyed = true;
        if (this.parent) this.parent.remove_child(this);
    }
}
class BackgroundActor extends Actor {}

function setup() {
    const root = new Actor();
    const pending = new Map();
    const sources = new Map();
    let next = 0;
    const context = vm.createContext({
        Clutter: {Clone: Actor}, Meta: {BackgroundActor},
        GLib: {PRIORITY_DEFAULT_IDLE: 0, SOURCE_REMOVE: false,
            idle_add(_priority, callback) { pending.set(++next, callback); return next; },
            Source: {remove(id) { pending.delete(id); }}},
        Main: {layoutManager: {overviewGroup: root, monitors: [
            {width: 1920, height: 1080}, {width: 1024, height: 768},
        ]}},
    });
    const source = readFileSync(new URL('../gnome-extension/blurMyShell.js', import.meta.url), 'utf8')
        .replace(/^import .*;\n/gm, '').replace('export class BlurMyShellWallpapers', 'class BlurMyShellWallpapers');
    const Mirrors = vm.runInContext(`${source}\nBlurMyShellWallpapers`, context);
    const mirrors = new Mirrors(index => sources.get(index) ?? null);
    function flush() {
        for (let round = 0; pending.size; round++) {
            assert.ok(round < 10, 'Refresh must settle without an idle loop');
            const callbacks = [...pending.values()]; pending.clear();
            callbacks.forEach(fn => fn());
        }
    }
    function addGroup() {
        const group = new Actor({name: 'bms-overview-backgroundgroup'});
        root.add_child(group);
        for (const monitor of [0, 1]) {
            const widget = new Actor({name: 'bms-overview-blurred-widget', effects: ['blur', 'brightness']});
            widget.add_child(new BackgroundActor({monitor}));
            group.add_child(widget);
        }
        flush();
        return group;
    }
    return {root, pending, sources, mirrors, flush, addGroup};
}

test('does nothing without BMS; late enable adds live sources under existing blur effects', () => {
    const t = setup();
    const ordinary = new Actor({name: 'some-other-background'});
    t.root.add_child(ordinary); t.flush();
    assert.equal(t.mirrors._widgets.size, 0);
    const source = new Actor(); t.sources.set(0, source);
    const group = t.addGroup();
    const [left, right] = [...t.mirrors._widgets.values()];
    assert.equal(left.clone.source, source);
    assert.deepEqual(left.clone.size, [1920, 1080]);
    assert.deepEqual(left.widget.effects, ['blur', 'brightness']);
    assert.equal(left.widget.children.at(-1), left.clone);
    assert.equal(right.clone, null); // Monitor without a renderer retains its image.
    t.mirrors.destroy();
    assert.equal(group.children[0].children.length, 1);
    assert.equal(ordinary.children.length, 0);
    assert.equal(t.root.signals.size, 0);
});

test('wallpaper and image changes keep one live clone above the original background', () => {
    const t = setup();
    const group = t.addGroup();
    const source = new Actor(); t.sources.set(1, source); t.mirrors.refresh();
    const widget = group.children[1];
    const record = t.mirrors._widgets.get(widget);
    const clone = record.clone;
    widget.children[0].destroy();
    widget.add_child(new BackgroundActor({monitor: 1})); t.flush();
    assert.equal(record.clone, clone);
    assert.equal(widget.children.at(-1), clone);
    t.sources.delete(1); t.mirrors.refresh(); t.flush();
    assert.ok(clone.destroyed);
    assert.equal(widget.children.length, 1);
    assert.equal(source.signals.size, 0);
    t.sources.set(1, source); t.mirrors.refresh();
    assert.ok(record.clone);
    t.mirrors.destroy();
});

test('BMS group recreation disconnects detached actors and preserves pipelines', () => {
    const t = setup();
    const source = new Actor(); t.sources.set(0, source);
    const old = t.addGroup();
    const oldWidget = old.children[0];
    const clone = t.mirrors._widgets.get(oldWidget).clone;
    t.root.remove_child(old);
    const current = t.addGroup();
    assert.ok(clone.destroyed);
    assert.equal(oldWidget.signals.size, 0);
    assert.equal(old.signals.size, 0);
    assert.equal(t.mirrors._widgets.size, 2);
    assert.ok(t.mirrors._widgets.get(current.children[0]).clone);
    assert.deepEqual(oldWidget.effects, ['blur', 'brightness']);
    t.mirrors.destroy();
    assert.equal(source.signals.size, 0);
});

test('widget/source destruction and extension disable release clones and pending callbacks', () => {
    const t = setup();
    const source = new Actor(); t.sources.set(0, source);
    const group = t.addGroup();
    const clone = t.mirrors._widgets.get(group.children[0]).clone;
    source.destroy(); t.sources.clear(); t.flush();
    assert.ok(clone.destroyed);
    group.children[0].destroy(); t.flush();
    assert.equal(t.mirrors._widgets.size, 1);
    t.root.remove_child(group);
    assert.ok(t.pending.size);
    t.mirrors.destroy();
    assert.equal(t.pending.size, 0);
    assert.equal(t.root.signals.size, 0);
    assert.equal(t.mirrors._widgets.size, 0);
});
