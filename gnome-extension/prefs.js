import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';
import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

export default class WallpaperPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        window._settings = settings;
        const page = new Adw.PreferencesPage({title: 'Wallpaper', icon_name: 'preferences-desktop-wallpaper-symbolic'});
        const group = new Adw.PreferencesGroup({title: 'Fullscreen auto-pause',
            description: 'Pause all bridge-connected renderers when a fullscreen application is on the current workspace. Activities overview resumes playback.'});
        page.add(group);
        window.add(page);
        const enabled = new Adw.SwitchRow({title: 'Pause for fullscreen applications'});
        settings.bind('pause-on-fullscreen', enabled, 'active', Gio.SettingsBindFlags.DEFAULT);
        group.add(enabled);
        const mode = new Adw.ComboRow({title: 'Application filter',
            subtitle: 'Blacklist ignores listed apps; whitelist pauses only for listed apps.',
            model: Gtk.StringList.new(['Blacklist', 'Whitelist'])});
        const syncMode = () => { mode.selected = settings.get_string('filter-mode') === 'whitelist' ? 1 : 0; };
        syncMode();
        const modeSignal = settings.connect('changed::filter-mode', syncMode);
        mode.connect('notify::selected', () => settings.set_string('filter-mode', mode.selected ? 'whitelist' : 'blacklist'));
        group.add(mode);
        const classes = new Adw.EntryRow({title: 'Window classes / app IDs (comma-separated)', show_apply_button: true});
        const listKey = () => settings.get_string('filter-mode') === 'whitelist'
            ? 'whitelist-window-classes' : 'window-classes';
        const syncClasses = () => { classes.text = settings.get_strv(listKey()).join(', '); };
        syncClasses();
        const classesSignals = ['window-classes', 'whitelist-window-classes', 'filter-mode']
            .map(key => settings.connect(`changed::${key}`, syncClasses));
        classes.connect('apply', () => settings.set_strv(listKey(),
            [...new Set(classes.text.split(',').map(value => value.trim()).filter(Boolean))]));
        group.add(classes);
        group.add(new Adw.ActionRow({title: 'Exact matches, ignoring letter case',
            subtitle: 'For example: org.gnome.Terminal, firefox. Apply the entry with its checkmark. An empty whitelist never pauses.'}));
        window.connect('close-request', () => {
            settings.disconnect(modeSignal);
            for (const signal of classesSignals) settings.disconnect(signal);
            return false;
        });
    }
}
