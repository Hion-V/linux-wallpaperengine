import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

// Blur My Shell v72 puts an image BackgroundActor inside each of these widgets
// and applies its selected effect pipeline to the widget. A live child is thus
// processed by the same effects, without replacing its pipeline or settings.
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
                const record = {widget, clone: null, source: null, sourceDestroy: 0, signals: []};
                this._widgets.set(widget, record);
                for (const signal of ['child-added', 'child-removed']) {
                    record.signals.push(widget.connect(signal, (_actor, child) => {
                        if (child !== record.clone)
                            this._queueRefresh();
                    }));
                }
                record.signals.push(widget.connect('destroy', () => this._remove(widget)));
            }
            this._sync(this._widgets.get(widget));
        }
    }

    _sync(record) {
        const {widget} = record;
        const background = widget.get_children().find(actor => actor instanceof Meta.BackgroundActor);
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
        record.clone.set_position(0, 0);
        record.clone.set_size(monitor.width, monitor.height);
        widget.set_child_above_sibling(record.clone, null);
    }

    _clearClone(record) {
        if (record.source && record.sourceDestroy)
            record.source.disconnect(record.sourceDestroy);
        record.sourceDestroy = 0;
        record.source = null;
        record.clone?.destroy();
        record.clone = null;
    }

    _remove(widget) {
        const record = this._widgets.get(widget);
        if (!record)
            return;
        this._widgets.delete(widget);
        for (const id of record.signals)
            widget.disconnect(id);
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
