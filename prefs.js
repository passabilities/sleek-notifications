import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';
import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

const ACCENTS = [['app', "Each app's color"], ['system', 'System accent']];
const POSITIONS = [['top-left', 'Top left'], ['top-center', 'Top center'], ['top-right', 'Top right']];

function spinRow(settings, key, title, subtitle, lower, upper, step) {
    const row = new Adw.SpinRow({
        title, subtitle,
        adjustment: new Gtk.Adjustment({lower, upper, step_increment: step, page_increment: step * 5}),
    });
    settings.bind(key, row, 'value', Gio.SettingsBindFlags.DEFAULT);
    return row;
}

function switchRow(settings, key, title, subtitle) {
    const row = new Adw.SwitchRow({title, subtitle});
    settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
    return row;
}

const SAMPLES = [
    ['New message from Alex', 'Are we still on for 3pm?'],
    ['Download complete', 'report-final.pdf is ready to open'],
    ['Calendar', 'Design review starts in 10 minutes'],
];
let sampleIndex = 0;

function sendTest(window) {
    const [summary, body] = SAMPLES[sampleIndex++ % SAMPLES.length];
    Gio.DBus.session.call(
        'org.freedesktop.Notifications',
        '/org/freedesktop/Notifications',
        'org.freedesktop.Notifications',
        'Notify',
        new GLib.Variant('(susssasa{sv}i)', [
            'Sleek Notifications', 0, 'preferences-system-notifications-symbolic',
            summary, body, [], {urgency: new GLib.Variant('y', 1)}, -1,
        ]),
        null, Gio.DBusCallFlags.NONE, -1, null,
        (conn, res) => {
            try {
                conn.call_finish(res);
            } catch (e) {
                window.add_toast(new Adw.Toast({title: `Couldn't send: ${e.message}`}));
            }
        });
}

export default class SleekNotificationsPrefs extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const s = this.getSettings();
        const page = new Adw.PreferencesPage({title: 'General', icon_name: 'preferences-system-notifications-symbolic'});

        const preview = new Adw.PreferencesGroup({title: 'Preview'});
        const testRow = new Adw.ActionRow({
            title: 'Test notification',
            subtitle: 'Shows a sample banner with your current settings',
        });
        const testBtn = new Gtk.Button({label: 'Send test', valign: Gtk.Align.CENTER});
        testBtn.add_css_class('suggested-action');
        testBtn.connect('clicked', () => sendTest(window));
        testRow.add_suffix(testBtn);
        testRow.activatable_widget = testBtn;
        preview.add(testRow);
        page.add(preview);

        const behavior = new Adw.PreferencesGroup({title: 'Behavior'});
        behavior.add(spinRow(s, 'timeout', 'Time on screen', 'Milliseconds before a banner leaves. Hovering pauses it.', 1000, 30000, 500));
        behavior.add(spinRow(s, 'max-visible', 'Banners at once', 'Newest on top; older ones move to the notification list', 1, 5, 1));
        behavior.add(switchRow(s, 'swipe-dismiss', 'Swipe to dismiss', 'Drag a banner toward the screen edge to clear it'));
        behavior.add(switchRow(s, 'keep-critical', 'Keep critical alerts', 'Low battery and similar alerts stay until dismissed'));
        page.add(behavior);

        const placement = new Adw.PreferencesGroup({title: 'Placement'});
        const pos = new Adw.ComboRow({
            title: 'Position',
            model: Gtk.StringList.new(POSITIONS.map(p => p[1])),
        });
        const syncPos = () => {
            pos.selected = Math.max(0, POSITIONS.findIndex(p => p[0] === s.get_string('position')));
        };
        syncPos();
        pos.connect('notify::selected', () => s.set_string('position', POSITIONS[pos.selected][0]));
        s.connect('changed::position', syncPos);
        placement.add(pos);
        placement.add(spinRow(s, 'edge-margin', 'Edge gap', 'Pixels from the screen edge', 0, 64, 2));
        placement.add(spinRow(s, 'width', 'Width', 'Banner width in pixels', 260, 640, 10));
        page.add(placement);

        const look = new Adw.PreferencesGroup({title: 'Look'});
        look.add(spinRow(s, 'opacity', 'Background opacity', 'Percent; lower is more see-through', 40, 100, 5));
        look.add(spinRow(s, 'corner-radius', 'Corner radius', 'Pixels', 0, 32, 1));
        look.add(switchRow(s, 'compact', 'Compact layout', 'Smaller icon and tighter spacing'));
        look.add(switchRow(s, 'accent-line', 'Accent underline', 'Thin colored line under the banner; off uses a soft top highlight'));
        const accent = new Adw.ComboRow({
            title: 'Accent color',
            subtitle: 'Used for the underline and countdown bar',
            model: Gtk.StringList.new(ACCENTS.map(a => a[1])),
        });
        const syncAccent = () => {
            accent.selected = Math.max(0, ACCENTS.findIndex(a => a[0] === s.get_string('accent-source')));
        };
        syncAccent();
        accent.connect('notify::selected', () => s.set_string('accent-source', ACCENTS[accent.selected][0]));
        s.connect('changed::accent-source', syncAccent);
        look.add(accent);
        page.add(look);

        const effects = new Adw.PreferencesGroup({title: 'Motion and effects'});
        effects.add(switchRow(s, 'slide-motion', 'Slide in from the edge', 'Off fades banners in place'));
        effects.add(switchRow(s, 'hover-lift', 'Lift on hover', 'Banner rises slightly under the pointer'));
        effects.add(switchRow(s, 'countdown-bar', 'Countdown bar', 'Shrinks until the banner leaves; pauses while you hover'));
        effects.add(switchRow(s, 'hover-close', 'Close button on hover only', 'Keeps the banner clean until you point at it'));
        page.add(effects);

        const center = new Adw.PreferencesGroup({title: 'Notification center'});
        center.add(switchRow(s, 'restyle-center', 'Restyle the notification center', 'Matching cards, header with Do not disturb and Clear all, tidier calendar'));
        center.add(switchRow(s, 'open-groups', 'Group by app, always open', 'Each app gets a header with its count; off uses GNOME\'s stacked piles'));
        page.add(center);

        window.add(page);
    }
}
