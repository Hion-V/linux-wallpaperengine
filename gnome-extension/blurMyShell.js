import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

// Blur My Shell applies its selected effect pipeline to each of these widgets.
// v72 put the image BackgroundActor directly inside the widget; v73 and newer
// put it in a source container. A live child of the effect widget is processed
// by the same effects without replacing its pipeline or settings.
const GROUP_NAME = 'bms-overview-backgroundgroup';
const WIDGET_NAME = 'bms-overview-blurred-widget';

export class BlurMyShellWallpapers {
    constructor(sourceForMonitor) {
        this._sourceForMonitor = sourceForMonitor;
        this._widgets = new Map();
        this._group = null;
        this._groupSignals = [];
        this._pending = 0;
        this._active = true;
        this._root = Main.layoutManager.overviewGroup;
        this._rootSignals = ['child-added', 'child-removed'].map(signal =>
            this._root.connect(signal, () => this._queueRefresh()));
        this.refresh();
    }

    _queueRefresh() {
        if (!this._active || this._pending)
            return;
        // BMS recreates whole actor trees when its pipeline or monitors change.
        // Wait until that operation finishes before inspecting the new children.
        this._pending = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._pending = 0;
            this.refresh();
            return GLib.SOURCE_REMOVE;
        });
    }

    refresh() {
        const group = this._root.get_children().find(actor => actor.name === GROUP_NAME) ?? null;
        if (group !== this._group) {
            this._detachGroup();
            this._group = group;
            if (group) {
                this._groupSignals = ['child-added', 'child-removed'].map(signal =>
                    group.connect(signal, () => this._queueRefresh()));
                this._groupSignals.push(group.connect('destroy', () => this._detachGroup()));
            }
        }
        if (!group)
            return;
        const widgets = new Set(group.get_children().filter(actor => actor.name === WIDGET_NAME));
        for (const widget of this._widgets.keys()) {
            if (!widgets.has(widget))
                this._remove(widget);
        }
        for (const widget of widgets) {
            if (!this._widgets.has(widget)) {
                const record = {widget, clone: null, source: null, sourceDestroy: 0,
                    signals: [], childSignals: new Map()};
                this._widgets.set(widget, record);
                record.signals.push(widget.connect('destroy', () => this._remove(widget)));
            }
            this._watchTree(this._widgets.get(widget));
            this._sync(this._widgets.get(widget));
        }
    }

    _watchTree(record) {
        const actors = new Set();
        const visit = actor => {
            if (actor === record.clone || actors.has(actor))
                return;
            actors.add(actor);
            for (const child of actor.get_children())
                visit(child);
        };
        visit(record.widget);
        for (const [actor, ids] of record.childSignals) {
            if (actors.has(actor))
                continue;
            for (const id of ids)
                actor.disconnect(id);
            record.childSignals.delete(actor);
        }
        for (const actor of actors) {
            if (record.childSignals.has(actor))
                continue;
            record.childSignals.set(actor, ['child-added', 'child-removed'].map(signal =>
                actor.connect(signal, (_parent, child) => {
                    if (child !== record.clone)
                        this._queueRefresh();
                })));
        }
    }

    _findBackground(actor, clone) {
        for (const child of actor.get_children()) {
            if (child === clone)
                continue;
            if (child instanceof Meta.BackgroundActor)
                return child;
            const background = this._findBackground(child, clone);
            if (background)
                return background;
        }
        return null;
    }

    _sync(record) {
        const {widget} = record;
        const background = this._findBackground(widget, record.clone);
        const monitor = background ? Main.layoutManager.monitors[background.monitor] : null;
        const source = monitor ? this._sourceForMonitor(background.monitor) : null;
        if (source !== record.source)
            this._clearClone(record);
        if (!source)
            return;
        if (!record.clone) {
            record.source = source;
            record.clone = new Clutter.Clone({source, reactive: false});
            record.sourceDestroy = source.connect('destroy', () => this._clearClone(record));
            widget.add_child(record.clone);
        }
        if (record.width !== monitor.width || record.height !== monitor.height) {
            record.clone.set_position(0, 0);
            record.clone.set_size(monitor.width, monitor.height);
            record.width = monitor.width;
            record.height = monitor.height;
        }
        if (widget.get_last_child() !== record.clone)
            widget.set_child_above_sibling(record.clone, null);
    }

    _clearClone(record) {
        if (record.source && record.sourceDestroy)
            record.source.disconnect(record.sourceDestroy);
        record.sourceDestroy = 0;
        record.source = null;
        record.clone?.destroy();
        record.clone = null;
        record.width = record.height = null;
    }

    _remove(widget) {
        const record = this._widgets.get(widget);
        if (!record)
            return;
        this._widgets.delete(widget);
        for (const id of record.signals)
            widget.disconnect(id);
        for (const [actor, ids] of record.childSignals) {
            for (const id of ids)
                actor.disconnect(id);
        }
        record.childSignals.clear();
        this._clearClone(record);
    }

    _detachGroup() {
        if (this._group) {
            for (const id of this._groupSignals)
                this._group.disconnect(id);
        }
        this._groupSignals = [];
        this._group = null;
        for (const widget of this._widgets.keys())
            this._remove(widget);
    }

    destroy() {
        this._active = false;
        if (this._pending)
            GLib.Source.remove(this._pending);
        this._pending = 0;
        for (const id of this._rootSignals)
            this._root.disconnect(id);
        this._detachGroup();
        this._sourceForMonitor = null;
        this._root = null;
    }
}
