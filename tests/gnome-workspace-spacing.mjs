import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

test('wallpaper workspace edges meet throughout swipes at every theme scale and direction', () => {
    let scale = 1;
    const manager = {layout_rows: 1};
    const sources = new Set([0]);
    class MonitorGroup {
        constructor(index, width, height) { this._monitor = {index, width, height}; }
        get index() { return this._monitor.index; }
        get baseDistance() {
            return (manager.layout_rows === -1 ? this._monitor.height : this._monitor.width) + 100 * scale;
        }
    }
    const original = Object.getOwnPropertyDescriptor(MonitorGroup.prototype, 'baseDistance');
    const source = readFileSync(new URL('../gnome-extension/workspaceSpacing.js', import.meta.url), 'utf8')
        .replace(/^import .*;\n/gm, '').replace('export class ', 'class ');
    const context = vm.createContext({MonitorGroup, global: {workspace_manager: manager}});
    const Spacing = vm.runInContext(`${source}\nWallpaperWorkspaceSpacing`, context);
    const spacing = new Spacing(index => sources.has(index));
    for (scale of [1, 2, 3]) {
        for (manager.layout_rows of [1, -1]) {
            for (const [width, height] of [[1920, 1080], [1707, 960], [1080, 1920]]) {
                const group = new MonitorGroup(0, width, height);
                const extent = manager.layout_rows === -1 ? height : width;
                assert.equal(group.baseDistance, extent);
                for (const direction of [-1, 1]) {
                    for (const progress of [0, 0.01, 0.25, 0.5, 0.99, 1, 1.5, 2]) {
                        const translation = -Math.round(progress * group.baseDistance);
                        const firstEdge = translation + (direction > 0 ? extent : 0);
                        const secondEdge = translation + direction * group.baseDistance + (direction < 0 ? extent : 0);
                        assert.equal(firstEdge, secondEdge);
                    }
                }
                const otherMonitor = new MonitorGroup(1, width, height);
                assert.equal(otherMonitor.baseDistance, extent + 100 * scale);
            }
        }
    }
    sources.clear();
    assert.equal(new MonitorGroup(0, 1920, 1080).baseDistance, 1080 + 100 * scale);
    spacing.destroy();
    assert.deepEqual(Object.getOwnPropertyDescriptor(MonitorGroup.prototype, 'baseDistance'), original);
});
