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
    emit(name) {
        for (const [signal, callback] of [...this.signals.values()])
            if (name === signal) callback(this);
    }
    add_child(child) { this.insert_child_at_index(child, this.children.length); }
    insert_child_at_index(child, index) { this.children.splice(index, 0, child); child.parent = this; }
    get_children() { return [...this.children]; }
    get_first_child() { return this.children[0]; }
    get_source() { return this.source; }
    get_width() { return this.width; }
    get_height() { return this.height; }
    allocate(box) { this.allocation = box; }
    queue_redraw() { this.redraws = (this.redraws ?? 0) + 1; }
    set_child_above_sibling(child) {
        this.children.splice(this.children.indexOf(child), 1);
        this.children.push(child);
    }
    set_position(x, y) { this.position = [x, y]; }
    set_size(w, h) { this.size = [w, h]; }
    add_effect(effect) { this.effect = effect; }
    destroy() {
        this.emit('destroy');
        this.signals.clear(); // Native GObject destruction disconnects handlers.
        this.destroyed = true;
        if (this.parent) this.parent.children.splice(this.parent.children.indexOf(this), 1);
    }
}

function setup() {
    class Background extends Actor {
        constructor(index) { super(); this._init(index); }
        _init(index) {
            this._monitorIndex = index;
            this._stateAdjustment = new Actor();
            this._bgManager = new Actor({backgroundActor: {content: {rounded_clip_radius: 30}}});
            this._backgroundGroup = new Actor();
            this._backgroundGroup.add_child(new Actor()); // Original GNOME background
        }
    }
    class Thumbnail extends Actor {
        constructor(index) { super(); this._init(index); }
        _init(index) { this.monitorIndex = index; this._contents = new Actor(); }
    }
    const originalBackground = Background.prototype._init;
    const originalThumbnail = Thumbnail.prototype._init;
    class InjectionManager {
        methods = [];
        overrideMethod(proto, name, build) {
            const original = proto[name];
            this.methods.push(() => { proto[name] = original; });
            proto[name] = build(original);
        }
        clear() { this.methods.forEach(restore => restore()); }
    }
    class Effect {
        uniforms = new Map();
        get_uniform_location(name) { return name; }
        set_uniform_float(name, _n, values) { this.uniforms.set(name, [...values]); }
    }
    const sources = new Map();
    const display = new Actor();
    const group = new Actor();
    const existing = new Background(0);
    group.add_child(existing);
    const monitors = [
        {x: -1280, y: 0, width: 1280, height: 720},
        {x: 0, y: 0, width: 1024, height: 768},
    ];
    const context = vm.createContext({
        Clutter: {Clone: Actor, Actor, LayoutManager: class {}, ActorBox: class {
            set_origin(x, y) { this.x = x; this.y = y; }
            set_size(width, height) { this.width = width; this.height = height; }
        }}, Cogl: {}, GObject: {registerClass: c => c},
        Shell: {GLSLEffect: Effect}, InjectionManager,
        WorkspaceBackground: Background, WorkspaceThumbnail: Thumbnail,
        Main: {layoutManager: {overviewGroup: group, monitors,
            getWorkAreaForMonitor: index => ({...monitors[index], y: 32, height: monitors[index].height - 32})}},
        global: {display},
    });
    const source = readFileSync(new URL('../gnome-extension/overview.js', import.meta.url), 'utf8')
        .replace(/^import .*;\n/gm, '').replace('export class OverviewWallpapers', 'class OverviewWallpapers');
    const Mirrors = vm.runInContext(`${source}\nOverviewWallpapers`, context);
    const mirrors = new Mirrors(index => sources.get(index) ?? null);
    return {mirrors, sources, existing, Background, Thumbnail, display,
        originalBackground, originalThumbnail};
}

test('existing and new workspaces select the correct monitor and reuse live sources', () => {
    const t = setup();
    const left = new Actor(), right = new Actor();
    t.sources.set(0, left); t.sources.set(1, right);
    t.mirrors.refresh();
    const background = new t.Background(1);
    const thumbnail = new t.Thumbnail(1);
    const records = [...t.mirrors._targets.values()];
    assert.deepEqual(records.map(r => r.source), [left, right, right]);
    const clones = records.map(r => r.clone);
    t.mirrors.refresh();
    assert.deepEqual(records.map(r => r.clone), clones);
    assert.deepEqual(clones[2].position, [0, 0]);
    assert.deepEqual(clones[2].size, [1024, 768]);
    assert.equal(thumbnail._contents.children[0], clones[2]);
    assert.equal(background._backgroundGroup.children.at(-1), records[1].container);
    assert.deepEqual(records[1].effect.uniforms.get('wallpaper_bounds'), [0, 32, 1024, 736]);
    t.mirrors.destroy();
});

test('disconnect or source destruction removes clones and leaves GNOME backgrounds intact', () => {
    const t = setup();
    const source = new Actor();
    t.sources.set(0, source); t.mirrors.refresh();
    let clone = t.mirrors._targets.get(t.existing).clone;
    t.sources.delete(0); t.mirrors.refresh();
    assert.ok(clone.destroyed);
    assert.equal(t.existing._backgroundGroup.children.length, 1);
    assert.equal(source.signals.size, 0);
    t.sources.set(0, source); t.mirrors.refresh();
    clone = t.mirrors._targets.get(t.existing).clone;
    source.destroy();
    assert.ok(clone.destroyed);
    assert.equal(t.mirrors._targets.get(t.existing).source, null);
    t.mirrors.destroy();
});

test('background changes preserve stacking and disable restores hooks and disconnects signals', () => {
    const t = setup();
    const source = new Actor();
    t.sources.set(0, source); t.mirrors.refresh();
    const clone = t.mirrors._targets.get(t.existing).clone;
    t.existing._backgroundGroup.add_child(new Actor());
    t.existing._bgManager.emit('changed');
    assert.equal(t.existing._backgroundGroup.children.at(-1), t.mirrors._targets.get(t.existing).container);
    t.mirrors.destroy();
    assert.equal(t.Background.prototype._init, t.originalBackground);
    assert.equal(t.Thumbnail.prototype._init, t.originalThumbnail);
    assert.equal(t.display.signals.size, 0);
    assert.equal(t.existing.signals.size, 0);
    assert.equal(t.existing._stateAdjustment.signals.size, 0);
    assert.equal(t.existing._bgManager.signals.size, 0);
    assert.equal(source.signals.size, 0);
    assert.ok(clone.destroyed);
});

test('destroying a workspace removes only its clones and signal connections', () => {
    const t = setup();
    const source = new Actor();
    t.sources.set(0, source); t.mirrors.refresh();
    const another = new t.Background(0);
    const clone = t.mirrors._targets.get(another).clone;
    another.destroy();
    assert.ok(clone.destroyed);
    assert.equal(t.mirrors._targets.size, 1);
    assert.equal(source.signals.size, 1);
    t.mirrors.destroy();
});


test('large previews preserve source aspect ratio and crop centrally at every allocation', () => {
    const t = setup();
    const source = new Actor({width: 1920, height: 1080});
    t.sources.set(0, source); t.mirrors.refresh();
    const {container, clone, effect} = t.mirrors._targets.get(t.existing);
    assert.ok(container.clip_to_allocation);
    assert.equal(container.effect, effect); // Rounded clipping follows the card, not the oversized clone.
    for (const [width, height] of [[1200, 400], [400, 800], [960, 540], [0, 0]]) {
        container.layout_manager.vfunc_allocate(container, {
            get_width: () => width, get_height: () => height,
        });
        const box = clone.allocation;
        assert.ok(Math.abs(box.width / 1920 - box.height / 1080) < 1e-9);
        assert.ok(box.width >= width && box.height >= height);
        assert.ok(Math.abs(box.x * 2 + box.width - width) < 1e-9);
        assert.ok(Math.abs(box.y * 2 + box.height - height) < 1e-9);
    }
    source.width = 1080; source.height = 1920;
    container.layout_manager.vfunc_allocate(container, {get_width: () => 1200, get_height: () => 400});
    assert.ok(Math.abs(clone.allocation.width / 1080 - clone.allocation.height / 1920) < 1e-9);
    t.mirrors.destroy();
});

test('mixed-scale carousel invalidates preview content only on resource-scale changes', () => {
    const t = setup();
    const source = new Actor({width: 1920, height: 1080});
    t.sources.set(0, source);
    t.mirrors.refresh();
    const {container, clone, effect} = t.mirrors._targets.get(t.existing);
    assert.equal(container.redraws ?? 0, 0);
    // 150% -> 100% crosses rounded resource scales 2 -> 1; test the return too.
    for (const scale of [1, 2]) {
        container.resourceScale = scale;
        container.emit('resource-scale-changed');
    }
    assert.equal(container.redraws, 2);
    for (let i = 0; i < 5; i++) t.mirrors.refresh();
    assert.equal(container.redraws, 2, 'ordinary updates must not force continuous repaint');
    assert.equal(t.mirrors._targets.get(t.existing).clone, clone);
    assert.equal(t.mirrors._targets.get(t.existing).effect, effect);
    t.sources.delete(0);
    t.mirrors.refresh();
    assert.equal(container.destroyed, true);
    assert.equal(container.signals.size, 0);
    t.sources.set(0, source);
    t.mirrors.refresh();
    const replacement = t.mirrors._targets.get(t.existing).container;
    replacement.emit('resource-scale-changed');
    assert.equal(replacement.redraws, 1);
    t.mirrors.destroy();
    assert.equal(replacement.signals.size, 0);
});
