import GLib from 'gi://GLib';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

export default class SleekNotificationsExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        const token = {};
        this._token = token;
        // Cache-busting query so edits to sleek.js load on the next enable,
        // without logging out.
        const url = `${this.dir.get_child('sleek.js').get_uri()}?t=${GLib.get_monotonic_time()}`;
        import(url).then(({Sleek}) => {
            if (this._token !== token)
                return;
            const impl = new Sleek(this._settings);
            impl.enable();
            this._impl = impl;
        }).catch(e => logError(e, 'sleek-notifications'));
    }

    disable() {
        this._token = null;
        this._impl?.disable();
        this._impl = null;
        this._settings = null;
    }
}
