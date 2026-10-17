import {MonitorGroup} from 'resource:///org/gnome/shell/ui/workspaceAnimation.js';

// Shell clips each workspace's desktop to the monitor, but normally places
// those desktops 100 * theme scale pixels apart. Use the monitor extent for
// both placement and swipe progress so the live wallpaper copies meet exactly.
export class WallpaperWorkspaceSpacing {
    constructor(sourceForMonitor) {
        this._original = Object.getOwnPropertyDescriptor(MonitorGroup.prototype, 'baseDistance');
        const original = this._original.get;
        Object.defineProperty(MonitorGroup.prototype, 'baseDistance', {
            ...this._original,
            get() {
                if (!sourceForMonitor(this.index))
                    return original.call(this);
                return global.workspace_manager.layout_rows === -1
                    ? this._monitor.height : this._monitor.width;
            },
        });
    }

    destroy() {
        Object.defineProperty(MonitorGroup.prototype, 'baseDistance', this._original);
    }
}
