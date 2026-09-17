import Clutter from 'gi://Clutter';
import Cogl from 'gi://Cogl';
import GObject from 'gi://GObject';
import Shell from 'gi://Shell';
import {InjectionManager} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {WorkspaceBackground} from 'resource:///org/gnome/shell/ui/workspace.js';
import {WorkspaceThumbnail} from 'resource:///org/gnome/shell/ui/workspaceThumbnail.js';

// BackgroundContent clips its own texture, not its actor's children. Apply the
// same work-area bounds and animated corner radius to the live window clone.
const OverviewClip = GObject.registerClass(
class WallpaperOverviewClip extends Shell.GLSLEffect {
    vfunc_build_pipeline() {
        this.add_glsl_snippet(Cogl.SnippetHook.FRAGMENT, `
            uniform vec2 wallpaper_size;
            uniform vec4 wallpaper_bounds;
            uniform float wallpaper_radius;
        `, `
            vec2 point = cogl_tex_coord_in[0].xy * wallpaper_size;
            vec2 half_size = wallpaper_bounds.zw * 0.5;
            vec2 center = wallpaper_bounds.xy + half_size;
            float radius = min(wallpaper_radius, min(half_size.x, half_size.y));
            vec2 edge = abs(point - center) - half_size + vec2(radius);
            float distance = length(max(edge, vec2(0.0)))
                + min(max(edge.x, edge.y), 0.0) - radius;
            float aa = max(fwidth(distance), 0.001);
            cogl_color_out *= 1.0 - smoothstep(-aa, aa, distance);
        `, false);
    }

    update(monitor, workArea, radius) {
        this.set_uniform_float(this.get_uniform_location('wallpaper_size'),
            2, [monitor.width, monitor.height]);
        this.set_uniform_float(this.get_uniform_location('wallpaper_bounds'),
            4, [workArea.x - monitor.x, workArea.y - monitor.y, workArea.width, workArea.height]);
        this.set_uniform_float(this.get_uniform_location('wallpaper_radius'), 1, [radius]);
    }
});

// The workspace card can have a different aspect ratio from its monitor (for
// example when the search field, dash, and thumbnails take up vertical space).
// Allocate the source at one uniform scale, centered and cropped to fill it.
const PreviewLayout = GObject.registerClass(
class WallpaperPreviewLayout extends Clutter.LayoutManager {
    vfunc_get_preferred_width() { return [0, 0]; }
    vfunc_get_preferred_height() { return [0, 0]; }

    vfunc_allocate(container, box) {
        const clone = container.get_first_child();
        const source = clone?.get_source();
        if (!source)
            return;
        const sourceWidth = source.get_width();
        const sourceHeight = source.get_height();
        if (sourceWidth <= 0 || sourceHeight <= 0)
            return;
        const width = box.get_width();
        const height = box.get_height();
        const scale = Math.max(width / sourceWidth, height / sourceHeight);
        const scaledWidth = sourceWidth * scale;
        const scaledHeight = sourceHeight * scale;
        const childBox = new Clutter.ActorBox();
        childBox.set_origin((width - scaledWidth) / 2, (height - scaledHeight) / 2);
        childBox.set_size(scaledWidth, scaledHeight);
        clone.allocate(childBox);
    }
});

export class OverviewWallpapers {
    constructor(sourceForMonitor) {
        this._sourceForMonitor = sourceForMonitor;
        this._targets = new Map();
        this._injections = new InjectionManager();
        const mirrors = this;
        // Hook creation, including workspaces added while the overview is open.
        // Limit the hooks to overview actors; desktop and lock-screen backgrounds
        // remain under Mutter/GNOME's control.
        for (const type of [WorkspaceBackground, WorkspaceThumbnail]) {
            this._injections.overrideMethod(type.prototype, '_init', original => function (...args) {
                original.apply(this, args);
                mirrors._track(this);
            });
        }
        this._workareas = global.display.connect('workareas-changed', () => this.refresh());
        // Cover actors constructed before the extension was enabled.
        this._visit(Main.layoutManager.overviewGroup);
    }

    _visit(actor) {
        if (actor instanceof WorkspaceBackground || actor instanceof WorkspaceThumbnail)
            this._track(actor);
        for (const child of actor.get_children())
            this._visit(child);
    }

    _track(actor) {
        if (this._targets.has(actor))
            return;
        const thumbnail = actor instanceof WorkspaceThumbnail;
        const record = {actor, thumbnail, clone: null, source: null, signals: []};
        this._targets.set(actor, record);
        record.signals.push([actor, actor.connect('destroy', () => this._remove(actor))]);
        if (!thumbnail) {
            record.signals.push([actor._stateAdjustment,
                actor._stateAdjustment.connect('notify::value', () => this._sync(record))]);
            record.signals.push([actor._bgManager,
                actor._bgManager.connect('changed', () => this._sync(record))]);
        }
        this._sync(record);
    }

    refresh() {
        for (const record of this._targets.values())
            this._sync(record);
    }

    _clearClone(record) {
        if (record.source && record.sourceDestroy)
            record.source.disconnect(record.sourceDestroy);
        record.sourceDestroy = 0;
        record.source = null;
        record.clone?.destroy();
        record.container?.destroy();
        record.container = null;
        record.clone = null;
        record.effect = null;
    }

    _sync(record) {
        const {actor, thumbnail} = record;
        const index = thumbnail ? actor.monitorIndex : actor._monitorIndex;
        const monitor = Main.layoutManager.monitors[index];
        const source = monitor ? this._sourceForMonitor(index) : null;
        if (record.source !== source)
            this._clearClone(record);
        if (!source)
            return;
        if (!record.clone) {
            record.source = source;
            record.clone = new Clutter.Clone({source, reactive: false});
            record.sourceDestroy = source.connect('destroy', () => this._clearClone(record));
            if (thumbnail) {
                actor._contents.insert_child_at_index(record.clone, 0);
            } else {
                record.effect = new OverviewClip();
                record.container = new Clutter.Actor({
                    reactive: false, x_expand: true, y_expand: true,
                    clip_to_allocation: true, layout_manager: new PreviewLayout(),
                });
                record.container.add_child(record.clone);
                record.container.add_effect(record.effect);
                actor._backgroundGroup.add_child(record.container);
            }
        }
        if (thumbnail) {
            // _contents is translated by the work area's stage coordinates.
            record.clone.set_position(monitor.x, monitor.y);
            record.clone.set_size(monitor.width, monitor.height);
        } else {
            record.effect.update(monitor, Main.layoutManager.getWorkAreaForMonitor(index),
                actor._bgManager.backgroundActor.content.rounded_clip_radius);
            // A settings change may have added a new background above our clone.
            actor._backgroundGroup.set_child_above_sibling(record.container, null);
        }
    }

    _remove(actor) {
        const record = this._targets.get(actor);
        if (!record)
            return;
        this._targets.delete(actor);
        for (const [object, id] of record.signals)
            object.disconnect(id);
        this._clearClone(record);
    }

    destroy() {
        this._injections.clear();
        global.display.disconnect(this._workareas);
        for (const actor of this._targets.keys())
            this._remove(actor);
        this._sourceForMonitor = null;
    }
}
