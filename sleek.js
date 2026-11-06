// The real implementation. extension.js loads this file with a cache-busting
// query, so disabling and re-enabling the extension picks up edits without
// logging out.
//
// GNOME shows one banner at a time. Here the extension draws its own stack of
// banners instead: GNOME still decides which notifications deserve a banner
// (it fills _notificationQueue), and our _updateState drains that queue into
// the stack.
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import Gio from 'gi://Gio';
import GdkPixbuf from 'gi://GdkPixbuf';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as MessageList from 'resource:///org/gnome/shell/ui/messageList.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';

const {Urgency, NotificationDestroyedReason} = MessageTray;


const IDLE_TIME = 1000;
const ENTER_TIME = 460;
const GROW_TIME = 260;
const LEAVE_TIME = 220;
const COLLAPSE_TIME = 200;
const DRAG_START = 6;
const SWIPE_THRESHOLD = 110;
const BANNER_MARGIN = 4; // matches .sleek-notification margin in stylesheet.css

export class Sleek {
    constructor(settings) {
        this._settings = settings;
    }

    enable() {
        const tray = Main.messageTray;
        this._tray = tray;
        this._stack = new Stack(this._settings, tray);
        const stack = this._stack;

        tray._updateState = function () {
            if (!Main.sessionMode.hasNotifications) {
                stack.clear();
                return;
            }
            const limited = this._busy || Main.layoutManager.primaryMonitor?.inFullscreen;
            if (limited)
                stack.expireNonUrgent();

            const waiting = [];
            for (const n of this._notificationQueue) {
                if (limited && !n.forFeedback && n.urgency !== Urgency.CRITICAL)
                    waiting.push(n);
                else
                    stack.show(n);
            }
            if (waiting.length !== this._notificationQueue.length) {
                this._notificationQueue = waiting;
                this.emit('queue-changed');
            }
        };

        this._syncCenter();
        this._settings.connectObject('changed::restyle-center', () => this._syncCenter(), this);

        // Hand over a banner GNOME may be showing right now; its hide callback
        // runs our _updateState, which drains the queue into the stack.
        if (tray._banner)
            tray._hideNotification(false);
        else
            tray._updateState();
    }

    _syncCenter() {
        const want = this._settings.get_boolean('restyle-center');
        if (want && !this._center) {
            this._center = new Center(this._settings);
            this._center.enable();
        } else if (!want && this._center) {
            this._center.disable();
            this._center = null;
        }
    }

    disable() {
        this._settings.disconnectObject(this);
        try {
            this._center?.disable();
        } catch (e) {
            console.log(`sleek-notifications: center cleanup: ${e.message}`);
        }
        this._center = null;
        delete this._tray._updateState;
        this._stack?.destroy();
        this._stack = null;
        this._tray._updateState();
    }
}

class Stack {
    constructor(settings, tray) {
        this.settings = settings;
        this.tray = tray;
        this.cards = [];
        this.idle = false;
        this._idleWatch = 0;

        this.container = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            reactive: true,
            track_hover: true,
        });
        Main.layoutManager.addTopChrome(this.container);
        this.container.connect('notify::hover', () => this.syncPause());

        Main.layoutManager.connectObject('monitors-changed', () => this.relayout(), this);
        global.display.connectObject('workareas-changed', () => this.relayout(), this);
        settings.connectObject('changed', (_s, key) => {
            if (key === 'accent-source')
                appColors.clear();
            this.relayout();
            this.cards.forEach(c => c.applyStyle());
        }, this);
        this.relayout();
    }

    destroy() {
        this.clear();
        if (this._idleWatch)
            this.tray.idleMonitor.remove_watch(this._idleWatch);
        Main.layoutManager.disconnectObject(this);
        global.display.disconnectObject(this);
        this.settings.disconnectObject(this);
        this.container.destroy();
    }

    get cardWidth() {
        return this.settings.get_int('width') + 2 * BANNER_MARGIN;
    }

    get position() {
        return this.settings.get_string('position');
    }

    relayout() {
        const lm = Main.layoutManager;
        if (!lm.primaryMonitor)
            return;
        const wa = lm.getWorkAreaForMonitor(lm.primaryIndex);
        const m = this.settings.get_int('edge-margin');
        const w = this.cardWidth;
        let x = wa.x + (wa.width - w) / 2;
        if (this.position === 'top-right')
            x = wa.x + wa.width - w - m;
        else if (this.position === 'top-left')
            x = wa.x + m;
        this.container.width = w;
        this.container.set_position(Math.round(x), wa.y + m);
    }

    show(notification) {
        notification.acknowledged = true;
        const existing = this.cards.find(c => c.notification === notification && !c.leaving);
        if (existing) {
            existing.refresh();
            return;
        }
        notification.playSound();

        const card = new Card(this, notification);
        this.cards.unshift(card);
        this.container.insert_child_at_index(card.actor, 0);
        card.enter();
        this.startCard(card);

        const max = this.settings.get_int('max-visible');
        const live = this.cards.filter(c => !c.leaving);
        live.slice(max).forEach(c => c.expire());
    }

    startCard(card) {
        if (card.sticky) {
            card.stopCountdown();
            return;
        }
        if (!this.idle && this.tray.idleMonitor.get_idletime() > IDLE_TIME) {
            // Hold banners while you're away; the countdown starts when you're back.
            this.idle = true;
            this._idleWatch = this.tray.idleMonitor.add_user_active_watch(() => {
                this._idleWatch = 0;
                this.idle = false;
                this.syncPause();
            });
        }
        card.restart(this.settings.get_int('timeout'));
    }

    get paused() {
        return this.container.hover || this.idle || this.cards.some(c => c.dragging);
    }

    syncPause() {
        const paused = this.paused;
        this.cards.forEach(c => (paused ? c.pause() : c.run()));
    }

    remove(card) {
        this.cards = this.cards.filter(c => c !== card);
    }

    expireNonUrgent() {
        this.cards.filter(c => c.notification.urgency !== Urgency.CRITICAL && !c.notification.forFeedback)
            .forEach(c => c.expire());
    }

    clear() {
        [...this.cards].forEach(c => c.destroy());
        this.cards = [];
    }

    colorFor(notification) {
        return appColor(this.settings, notification);
    }
}

class Card {
    constructor(stack, notification) {
        this.stack = stack;
        this.settings = stack.settings;
        this.notification = notification;
        this.leaving = false;
        this.dragging = false;
        this._grown = false;
        this._timeoutId = 0;
        this._remaining = 0;
        this._startedAt = 0;

        this.actor = new St.Widget({
            layout_manager: new Clutter.BinLayout(),
            reactive: true,
            track_hover: true,
            clip_to_allocation: true,
            x_expand: true,
        });
        this.actor.set_pivot_point(0.5, 0.5);

        this.banner = new MessageList.NotificationMessage(notification);
        this.banner.can_focus = false;
        this.banner._header.expandButton.visible = false;
        this.actor.add_child(this.banner);

        this.bar = new St.Widget({
            style_class: 'sleek-progress',
            x_expand: true,
            y_expand: true,
            y_align: Clutter.ActorAlign.END,
            visible: false,
        });
        this.bar.set_pivot_point(0, 0.5);
        this.actor.add_child(this.bar);

        if (notification.urgency === Urgency.CRITICAL || notification.source.policy.forceExpanded)
            this.banner.expand(false);

        this.actor.connect('notify::hover', () => this._onHover());
        this.actor.connect('captured-event', (_a, event) => this._onEvent(event));
        notification.connectObject('destroy', () => this.leave(0), this);
        this.applyStyle();
    }

    get sticky() {
        return this.notification.urgency === Urgency.CRITICAL &&
            this.settings.get_boolean('keep-critical');
    }

    applyStyle() {
        const s = this.settings;
        const color = this.stack.colorFor(this.notification);
        const accent = s.get_boolean('accent-line');
        const a = (s.get_int('opacity') / 100).toFixed(2);
        const b = this.banner;
        const toggle = (cls, on) => b[on ? 'add_style_class_name' : 'remove_style_class_name'](cls);

        toggle('sleek-notification', true);
        toggle('sleek-compact', s.get_boolean('compact'));
        toggle('sleek-accent', accent);
        toggle('sleek-highlight', !accent);
        let style = `background-color: rgba(38, 40, 49, ${a});` +
            `border-radius: ${s.get_int('corner-radius')}px;` +
            `width: ${s.get_int('width')}px;`;
        b.set_style(style);
        restyleMessage(b, color);

        const side = BANNER_MARGIN + Math.max(10, s.get_int('corner-radius'));
        this.bar.set_style(`margin: 0 ${side}px ${BANNER_MARGIN + 5}px ${side}px;` +
            (color ? `background-color: ${rgb(color, 0.9)};` : ''));
        if (!s.get_boolean('countdown-bar'))
            this.bar.visible = false;

        b._header.closeButton.opacity = s.get_boolean('hover-close') && !this.actor.hover ? 0 : 255;
    }

    // ---- motion ------------------------------------------------------------

    _offscreen(sign = 0) {
        const away = this.stack.cardWidth + this.settings.get_int('edge-margin') + 40;
        if (sign)
            return [sign * away, 0];
        const pos = this.stack.position;
        if (!this.settings.get_boolean('slide-motion'))
            return [0, 0];
        if (pos === 'top-right')
            return [away, 0];
        if (pos === 'top-left')
            return [-away, 0];
        return [0, -40];
    }

    enter() {
        const [, natHeight] = this.actor.get_preferred_height(this.stack.cardWidth);
        const [tx, ty] = this._offscreen();
        this.actor.height = 0;
        this.actor.opacity = 0;
        this.actor.translation_x = tx;
        this.actor.translation_y = ty;

        this.actor.ease({
            height: natHeight,
            duration: GROW_TIME,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onComplete: () => {
                if (!this.leaving) {
                    this.actor.height = -1;
                    this._grown = true;
                }
            },
        });
        this.actor.ease({
            opacity: 255,
            translation_x: 0,
            translation_y: 0,
            duration: ENTER_TIME,
            mode: Clutter.AnimationMode.EASE_OUT_BACK,
        });
    }

    leave(sign) {
        if (this.leaving)
            return;
        this.leaving = true;
        this.pause();
        this.stack.remove(this);
        this.notification?.disconnectObject(this);

        const [tx, ty] = this._offscreen(sign);
        this.actor.remove_transition('translation-x');
        this.actor.remove_transition('opacity');
        this.actor.ease({
            opacity: 0,
            translation_x: tx,
            translation_y: ty,
            duration: LEAVE_TIME,
            mode: Clutter.AnimationMode.EASE_IN_CUBIC,
            onStopped: () => {
                this.actor.remove_transition('height');
                this.actor.height = this.actor.height;
                this.actor.ease({
                    height: 0,
                    duration: COLLAPSE_TIME,
                    mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                    onStopped: () => this.destroy(),
                });
            },
        });
    }

    expire() {
        if (this.leaving)
            return;
        if (this.notification.isTransient)
            this.notification.destroy(NotificationDestroyedReason.EXPIRED);
        else
            this.leave(0);
    }

    destroy() {
        this.leaving = true;
        this.pause();
        this._grab?.dismiss();
        this._grab = null;
        this.stack.remove(this);
        this.notification?.disconnectObject(this);
        this.notification = null;
        if (!this._destroyed) {
            this._destroyed = true;
            this.actor.destroy();
        }
    }

    // ---- countdown ---------------------------------------------------------

    refresh() {
        this.notification.playSound?.();
        this.actor.ease({
            scale_x: 1.03, scale_y: 1.03,
            duration: 120,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onComplete: () => this.actor.ease({scale_x: 1, scale_y: 1, duration: 180}),
        });
        this.stack.startCard(this);
    }

    restart(ms) {
        this.pause();
        this._remaining = ms;
        this.bar.remove_all_transitions();
        this.bar.scale_x = 1;
        this.bar.visible = this.settings.get_boolean('countdown-bar');
        this.bar.ease({scale_x: 0, duration: ms, mode: Clutter.AnimationMode.LINEAR});
        if (this.stack.paused)
            this.pause();
        else
            this.run();
    }

    stopCountdown() {
        this.pause();
        this._remaining = 0;
        this.bar.remove_all_transitions();
        this.bar.visible = false;
    }

    run() {
        if (this._timeoutId || this._remaining <= 0 || this.leaving)
            return;
        this._startedAt = GLib.get_monotonic_time();
        this._timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, Math.max(1, Math.round(this._remaining)), () => {
            this._timeoutId = 0;
            this._remaining = 0;
            this.expire();
            return GLib.SOURCE_REMOVE;
        });
        this.bar.get_transition('scale-x')?.start();
    }

    pause() {
        if (this._timeoutId) {
            GLib.source_remove(this._timeoutId);
            this._timeoutId = 0;
            this._remaining -= (GLib.get_monotonic_time() - this._startedAt) / 1000;
        }
        this.bar.get_transition('scale-x')?.pause();
    }

    // ---- hover, click and swipe -------------------------------------------

    _onHover() {
        if (this.leaving)
            return;
        const hover = this.actor.hover;
        const s = this.settings;
        this.banner[hover ? 'add_style_class_name' : 'remove_style_class_name']('sleek-hover');
        if (s.get_boolean('hover-lift')) {
            const scale = hover ? 1.015 : 1;
            this.actor.ease({scale_x: scale, scale_y: scale, duration: 180, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
        }
        if (s.get_boolean('hover-close')) {
            this.banner._header.closeButton.ease({
                opacity: hover ? 255 : 0, duration: 150, mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            });
        }
        // Reveal action buttons while hovered, like GNOME's own banner.
        if (this.banner._actionBin.child && this._grown) {
            if (hover)
                this.banner.expand(true);
            else if (!this.sticky)
                this.banner.unexpand(true);
        }
    }

    _swipe(dx) {
        const pos = this.stack.position;
        const allowed = pos === 'top-right' ? dx > 0 : pos === 'top-left' ? dx < 0 : true;
        return allowed ? dx : dx * 0.15; // rubber-band the wrong way
    }

    _onEvent(event) {
        const type = event.type();
        if (type === Clutter.EventType.BUTTON_PRESS && event.get_button() === 1 && !this.leaving) {
            this._press = {x: event.get_coords()[0], actor: global.stage.get_event_actor(event)};
            this._grab = global.stage.grab(this.actor);
            return Clutter.EVENT_STOP;
        }
        if (!this._press)
            return Clutter.EVENT_PROPAGATE;

        const dx = event.get_coords()[0] - this._press.x;
        if (type === Clutter.EventType.MOTION) {
            if (!this.dragging && Math.abs(dx) > DRAG_START && this.settings.get_boolean('swipe-dismiss')) {
                this.dragging = true;
                this.actor.remove_transition('translation-x');
                this.stack.syncPause();
            }
            if (this.dragging) {
                const d = this._swipe(dx);
                this.actor.translation_x = d;
                this.actor.opacity = Math.max(40, Math.round(255 * (1 - Math.abs(d) / (this.stack.cardWidth * 1.2))));
            }
            return Clutter.EVENT_STOP;
        }
        if (type === Clutter.EventType.BUTTON_RELEASE && event.get_button() === 1) {
            const press = this._press;
            this._press = null;
            this._grab?.dismiss();
            this._grab = null;
            if (this.dragging) {
                this.dragging = false;
                const d = this._swipe(dx);
                if (Math.abs(d) > SWIPE_THRESHOLD) {
                    const n = this.notification;
                    this.leave(Math.sign(d));
                    n?.destroy(NotificationDestroyedReason.DISMISSED);
                } else {
                    this.actor.ease({
                        translation_x: 0, opacity: 255,
                        duration: 260, mode: Clutter.AnimationMode.EASE_OUT_BACK,
                    });
                }
                this.stack.syncPause();
            } else {
                this._click(press.actor);
            }
            return Clutter.EVENT_STOP;
        }
        return Clutter.EVENT_PROPAGATE;
    }

    // We take the press to make swiping possible, so replay a plain click on
    // whichever button (close, action or the banner itself) was pressed.
    _click(actor) {
        for (let a = actor; a && a !== this.actor; a = a.get_parent()) {
            if (a instanceof St.Button) {
                a.emit('clicked', 1);
                return;
            }
        }
    }
}


// ---- notification center ---------------------------------------------------

const SWIPE_LIST_THRESHOLD = 110;
const CARD_DECOR = 'sleek-list-card';

class Center {
    constructor(settings) {
        this.settings = settings;
        this._decorated = new Set();
    }

    enable() {
        const dm = Main.panel.statusArea.dateMenu;
        const list = dm?._messageList;
        if (!list)
            return;
        this._dm = dm;
        this._list = list;
        this._view = list._messageView;
        dm.menu.box.add_style_class_name('sleek-center');

        this._buildHeader();

        // Friendlier empty state.
        this._placeholderLabel = list._placeholder?._label;
        if (this._placeholderLabel) {
            this._origPlaceholder = this._placeholderLabel.text;
            this._placeholderLabel.text = "You're all caught up";
        }

        // Style list cards as they're created, and the ones already there.
        const proto = MessageList.NotificationMessageGroup.prototype;
        this._origAdd = proto._addNotification;
        const center = this;
        const origAdd = this._origAdd;
        proto._addNotification = function (notification) {
            origAdd.call(this, notification);
            const message = this._notificationToMessage?.get(notification);
            if (message)
                center._decorate(message);
        };
        this._walk(this._view, a => {
            if (a instanceof MessageList.NotificationMessage)
                this._decorate(a);
        });

        this.settings.connectObject('changed', () => this._decorated.forEach(m => this._style(m)), this);

        // Keep every app group open under its own header, like the mockup.
        this._openGroups = new Set();
        const view = this._view;
        const origAddSource = view._addNotificationSource;
        view._addNotificationSource = function (source) {
            origAddSource.call(this, source);
            const group = this._notificationSourceToGroup.get(source);
            if (group && center.settings.get_boolean('open-groups'))
                center._openGroup(group);
        };
        this._syncGroups();
        this.settings.connectObject('changed::open-groups', () => this._syncGroups(), this);
    }

    _groups() {
        return [...(this._view._notificationSourceToGroup?.values() ?? [])];
    }

    _syncGroups() {
        if (this.settings.get_boolean('open-groups'))
            this._groups().forEach(g => this._openGroup(g));
        else
            [...this._openGroups].forEach(g => this._closeGroup(g));
    }

    _openGroup(group) {
        if (this._openGroups.has(group))
            return;
        this._openGroups.add(group);
        // Forget groups GNOME destroys (their app's last notification went away).
        group.connect('destroy', () => this._openGroups.delete(group));

        // If GNOME had this group expanded, release it without its dimming.
        if (this._view.expandedGroup === group)
            this._view._setExpandedGroup(null).catch(() => {});

        // Swallow the click-to-stack toggle while the group stays open.
        group.emit = function (name, ...args) {
            if (name === 'expand-toggle-requested')
                return undefined;
            return GObject.Object.prototype.emit.call(this, name, ...args);
        };

        const header = group._headerBox;
        header.get_children()
            .filter(c => c.has_style_class_name?.('sleek-group-icon') || c.has_style_class_name?.('sleek-count'))
            .forEach(c => c.destroy());
        const icon = new St.Icon({
            gicon: group.source?.icon ?? null,
            fallback_icon_name: 'application-x-executable-symbolic',
            style_class: 'sleek-group-icon',
            y_align: Clutter.ActorAlign.CENTER,
        });
        const count = new St.Label({style_class: 'sleek-count', y_align: Clutter.ActorAlign.CENTER});
        header.insert_child_at_index(icon, 0);
        header.insert_child_at_index(count, 2);
        const syncCount = () => {
            count.text = String(group._notificationToMessage.size);
        };
        group.source?.connectObject(
            'notification-added', syncCount,
            'notification-removed', syncCount, group._sleekHeaderKey = {});
        syncCount();
        group._unexpandButton.visible = false;
        group._sleekHeader = {icon, count};

        group._expanded = true;
        group._cover.hide();
        header.show();
        group.layout_manager.expansion = 1;
        group._updateStackedMessagesFade();
        group.add_style_class_name('sleek-open-group');
    }

    _closeGroup(group) {
        if (!this._openGroups.delete(group) || !group.layout_manager)
            return;
        delete group.emit;
        group.source?.disconnectObject(group._sleekHeaderKey);
        group._sleekHeader?.icon.destroy();
        group._sleekHeader?.count.destroy();
        delete group._sleekHeader;
        group._unexpandButton.visible = true;
        group.remove_style_class_name('sleek-open-group');
        group._expanded = false;
        group._cover.show();
        group._headerBox.hide();
        group.layout_manager.expansion = 0;
        group._updateStackedMessagesFade();
    }

    disable() {
        if (!this._dm)
            return;
        // Each step runs on its own so one failure can't leave the rest behind.
        const step = (name, fn) => {
            try {
                fn();
            } catch (e) {
                console.log(`sleek-notifications: cleanup ${name}: ${e.message}`);
            }
        };
        step('hooks', () => {
            MessageList.NotificationMessageGroup.prototype._addNotification = this._origAdd;
            delete this._view._addNotificationSource;
        });
        step('signals', () => {
            this.settings.disconnectObject(this);
            Main.messageTray.disconnectObject(this);
            Main.messageTray.getSources().forEach(s => s.disconnectObject(this));
            this._dm.menu.disconnectObject(this);
            this._dndSettings?.disconnectObject(this);
        });
        step('header', () => {
            this._header?.destroy();
            if (this._controls)
                this._controls.visible = true;
            if (this._placeholderLabel)
                this._placeholderLabel.text = this._origPlaceholder;
            this._dm.menu.box.remove_style_class_name('sleek-center');
        });
        for (const g of [...(this._openGroups ?? [])])
            step('group', () => this._closeGroup(g));
        for (const m of [...this._decorated])
            step('card', () => this._undecorate(m));
        this._decorated.clear();
        this._dm = null;
    }

    _walk(actor, fn) {
        fn(actor);
        actor.get_children().forEach(c => this._walk(c, fn));
    }

    // ---- header: title, count, Do not disturb, Clear all ------------------

    _buildHeader() {
        const list = this._list;
        const box = list._scrollView.get_parent();
        this._controls = list._clearButton.get_parent();
        this._controls.visible = false;

        this._header = new St.BoxLayout({style_class: 'sleek-center-header', x_expand: true});
        this._header.add_child(new St.Label({
            text: 'Notifications', style_class: 'sleek-center-title', y_align: Clutter.ActorAlign.CENTER,
        }));
        this._count = new St.Label({style_class: 'sleek-count', y_align: Clutter.ActorAlign.CENTER});
        this._header.add_child(this._count);
        this._header.add_child(new St.Widget({x_expand: true}));

        const dndBox = new St.BoxLayout({style_class: 'sleek-pill-box'});
        dndBox.add_child(new St.Icon({icon_name: 'notifications-disabled-symbolic', style_class: 'sleek-pill-icon'}));
        dndBox.add_child(new St.Label({text: 'Do not disturb', y_align: Clutter.ActorAlign.CENTER}));
        this._dnd = new St.Button({style_class: 'sleek-pill', child: dndBox, can_focus: true});
        this._dndSettings = new Gio.Settings({schema_id: 'org.gnome.desktop.notifications'});
        this._dnd.connect('clicked', () => {
            const banners = this._dndSettings.get_boolean('show-banners');
            this._dndSettings.set_boolean('show-banners', !banners);
        });
        this._dndSettings.connectObject('changed::show-banners', () => this._syncDnd(), this);
        this._header.add_child(this._dnd);

        this._clear = new St.Button({style_class: 'sleek-pill', label: 'Clear all', can_focus: true});
        this._clear.connect('clicked', () => this._view.clear());
        this._view.bind_property('can-clear', this._clear, 'reactive', GObject.BindingFlags.SYNC_CREATE);
        list._placeholder.bind_property('visible', this._clear, 'visible',
            GObject.BindingFlags.SYNC_CREATE | GObject.BindingFlags.INVERT_BOOLEAN);
        this._header.add_child(this._clear);

        // Remove a header a crashed earlier run may have left behind.
        box.get_children().filter(c => c.has_style_class_name?.('sleek-center-header'))
            .forEach(c => c.destroy());
        box.insert_child_at_index(this._header, 0);

        const watch = source => source.connectObject(
            'notification-added', () => this._syncCount(),
            'notification-removed', () => this._syncCount(), this);
        Main.messageTray.getSources().forEach(watch);
        Main.messageTray.connectObject(
            'source-added', (_t, source) => {
                watch(source);
                this._syncCount();
            },
            'source-removed', () => this._syncCount(), this);
        this._dm.menu.connectObject('open-state-changed', (_m, open) => {
            if (open)
                this._syncCount();
        }, this);

        this._syncDnd();
        this._syncCount();
    }

    _syncDnd() {
        const on = !this._dndSettings.get_boolean('show-banners');
        this._dnd[on ? 'add_style_class_name' : 'remove_style_class_name']('sleek-pill-active');
    }

    _syncCount() {
        const n = Main.messageTray.getSources().reduce((sum, s) => sum + s.notifications.length, 0);
        this._count.text = String(n);
        this._count.visible = n > 0;
    }

    // ---- list cards --------------------------------------------------------

    _decorate(message) {
        if (this._decorated.has(message))
            return;
        this._decorated.add(message);
        message.add_style_class_name(CARD_DECOR);
        restyleMessage(message, appColor(this.settings, message.notification));
        this._style(message);

        message.connectObject(
            'notify::hover', () => this._syncClose(message),
            'destroy', () => this._decorated.delete(message), this);

        // A dead zone so ordinary clicks (expand, close, open) never turn into a swipe.
        const pan = new Clutter.PanGesture({pan_axis: Clutter.PanAxis.X, begin_threshold: 20});
        const deltaX = () => {
            const v = pan.get_accumulated_delta();
            return Array.isArray(v) ? v[0] : v.get_x();
        };
        pan.connect('pan-update', () => {
            const dx = deltaX();
            message.translation_x = dx;
            message.opacity = Math.max(40, Math.round(255 * (1 - Math.abs(dx) / 420)));
        });
        pan.connect('end', () => {
            const dx = deltaX();
            if (Math.abs(dx) > SWIPE_LIST_THRESHOLD && this.settings.get_boolean('swipe-dismiss')) {
                message.ease({
                    translation_x: Math.sign(dx) * 520, opacity: 0,
                    duration: 200, mode: Clutter.AnimationMode.EASE_IN_CUBIC,
                    onComplete: () => message.close(),
                });
            } else {
                this._springBack(message);
            }
        });
        pan.connect('cancel', () => this._springBack(message));
        message.add_action_with_name('sleek-swipe', pan);
        message._sleekPan = pan;
    }

    _springBack(message) {
        message.ease({translation_x: 0, opacity: 255, duration: 260, mode: Clutter.AnimationMode.EASE_OUT_BACK});
    }

    _style(message) {
        if (message._sleek)
            restyleMessage(message, appColor(this.settings, message.notification));
        this._syncClose(message);
    }

    _syncClose(message) {
        const hide = this.settings.get_boolean('hover-close') && !message.hover;
        message._header.closeButton.ease({
            opacity: hide ? 0 : 255, duration: 150, mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
    }

    _undecorate(message) {
        message.disconnectObject(this);
        if (message._sleekPan) {
            message.remove_action(message._sleekPan);
            delete message._sleekPan;
        }
        restoreMessage(message);
        message.remove_style_class_name(CARD_DECOR);
        message.set_style(null);
        message.translation_x = 0;
        message.opacity = 255;
        message._header.closeButton.opacity = 255;
    }
}




// ---- card layout (shared by banners and the notification center) ----------
//
// GNOME's message puts the app name, time and close button on a row above the
// content. This rearranges it into: [color edge] [app tile] [app · time /
// title / body] [close], and puts everything back on restore.

function restyleMessage(message, color) {
    if (!message._sleek) {
        const header = message._header;
        const hbox = message._icon.get_parent();
        const contentBox = message.titleLabel.get_parent();
        const headerContent = header.get_children()
            .find(c => c.has_style_class_name?.('message-header-content'));
        const st = {header, moved: [], aligns: []};
        const move = (actor, parent, index) => {
            const old = actor.get_parent();
            st.moved.push([actor, old, old.get_children().indexOf(actor)]);
            old.remove_child(actor);
            if (index === undefined)
                parent.add_child(actor);
            else
                parent.insert_child_at_index(actor, index);
        };

        if (headerContent) {
            move(headerContent, contentBox, 0);
            headerContent.add_style_class_name('sleek-meta');
            st.headerContent = headerContent;
        }
        // Close above expand, in one narrow column, so the text keeps its width.
        st.buttons = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            style_class: 'sleek-buttons',
            y_align: Clutter.ActorAlign.START,
        });
        hbox.add_child(st.buttons);
        for (const button of [header.closeButton, header.expandButton]) {
            st.aligns.push([button, button.y_align]);
            button.y_align = Clutter.ActorAlign.START;
            move(button, st.buttons);
        }
        header.visible = false;

        // GNOME keeps the body's "…" cut-off while expanded, which makes the
        // label measure as one line, so expanding never shows more text.
        const text = message._bodyLabel.clutter_text;
        st.ellipsize = text.ellipsize;
        st.expandLines = message._bodyBin.layout_manager.expandLines;
        message._bodyBin.layout_manager.expandLines = 20;
        message.connectObject(
            'expanded', () => {
                text.ellipsize = Pango.EllipsizeMode.NONE;
                message._bodyBin.queue_relayout();
            },
            'unexpanded', () => {
                GLib.timeout_add(GLib.PRIORITY_DEFAULT, MessageTray.ANIMATION_TIME + 20, () => {
                    if (message._sleek && !message.expanded)
                        text.ellipsize = st.ellipsize;
                    return GLib.SOURCE_REMOVE;
                });
            }, st);
        if (message.expanded)
            text.ellipsize = Pango.EllipsizeMode.NONE;

        const icon = new St.Icon({
            gicon: message.notification?.source?.icon ?? null,
            fallback_icon_name: 'application-x-executable-symbolic',
            style_class: 'sleek-app-icon',
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
            x_expand: true,
            y_expand: true,
        });
        st.tile = new St.Bin({style_class: 'sleek-app-tile', y_align: Clutter.ActorAlign.START, child: icon});
        hbox.insert_child_at_index(st.tile, 0);
        // The notification's own image (avatar, site logo) wins over the app tile.
        st.binding = message._icon.bind_property('visible', st.tile, 'visible',
            GObject.BindingFlags.SYNC_CREATE | GObject.BindingFlags.INVERT_BOOLEAN);

        st.edge = new St.Widget({style_class: 'sleek-edge', y_expand: true, visible: false});
        hbox.insert_child_at_index(st.edge, 0);

        message.add_style_class_name('sleek-card-layout');
        message._sleek = st;
    }
    const {edge, tile} = message._sleek;
    edge.visible = !!color;
    edge.set_style(color ? `background-color: ${rgb(color)};` : null);
    tile.set_style(color ? `background-color: ${rgb(color, 0.18)};` : null);
}

function restoreMessage(message) {
    const st = message._sleek;
    if (!st)
        return;
    st.binding?.unbind();
    message.disconnectObject(st);
    message._bodyLabel.clutter_text.ellipsize = st.ellipsize;
    message._bodyBin.layout_manager.expandLines = st.expandLines;
    st.tile.destroy();
    st.edge.destroy();
    for (const [actor, old, index] of st.moved.reverse()) {
        actor.get_parent()?.remove_child(actor);
        old.insert_child_at_index(actor, index);
    }
    st.buttons.destroy();
    for (const [button, align] of st.aligns)
        button.y_align = align;
    st.headerContent?.remove_style_class_name('sleek-meta');
    st.header.visible = true;
    message.remove_style_class_name('sleek-card-layout');
    delete message._sleek;
}

// ---- app colors ------------------------------------------------------------

const appColors = new Map();

function appColor(settings, notification) {
    if (settings.get_string('accent-source') !== 'app')
        return null;
    const source = notification?.source;
    if (!source)
        return null;
    if (!appColors.has(source)) {
        let color = null;
        try {
            color = iconColor(source.icon);
        } catch (e) {
            console.log(`sleek-notifications: no app color: ${e.message}`);
        }
        appColors.set(source, color);
    }
    return appColors.get(source);
}

function rgb([r, g, b], alpha = 1) {
    return alpha === 1 ? `rgb(${r}, ${g}, ${b})` : `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function iconPath(gicon) {
    if (!gicon)
        return null;
    if (gicon instanceof Gio.FileIcon)
        return gicon.get_file().get_path();
    if (gicon instanceof Gio.ThemedIcon) {
        const info = new St.IconTheme().lookup_by_gicon(gicon, 48, St.IconLookupFlags.FORCE_SIZE);
        return info?.get_filename() ?? null;
    }
    return null;
}

// The dominant saturated color of an app icon, tuned to read on a dark card.
// Returns null for grey or monochrome icons so they use the system accent.
function iconColor(gicon) {
    const path = iconPath(gicon);
    if (!path)
        return null;
    const pb = GdkPixbuf.Pixbuf.new_from_file_at_size(path, 32, 32);
    const px = pb.get_pixels();
    const n = pb.get_n_channels();
    const stride = pb.get_rowstride();
    const hasAlpha = pb.get_has_alpha();
    let r = 0, g = 0, b = 0, total = 0;
    for (let y = 0; y < pb.get_height(); y++) {
        for (let x = 0; x < pb.get_width(); x++) {
            const i = y * stride + x * n;
            const R = px[i], G = px[i + 1], B = px[i + 2];
            const A = hasAlpha ? px[i + 3] / 255 : 1;
            const max = Math.max(R, G, B), min = Math.min(R, G, B);
            const sat = max ? (max - min) / max : 0;
            const w = A * sat * sat * (max > 50 ? 1 : 0.1);
            r += R * w; g += G * w; b += B * w; total += w;
        }
    }
    if (total < 1)
        return null;
    let [h, s, l] = toHsl(r / total, g / total, b / total);
    if (s < 0.25)
        return null;
    s = Math.max(s, 0.6);
    l = Math.min(Math.max(l, 0.52), 0.66);
    return fromHsl(h, s, l);
}

function toHsl(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    const l = (max + min) / 2;
    if (max === min)
        return [0, 0, l];
    const d = max - min;
    const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    let h;
    if (max === r)
        h = (g - b) / d + (g < b ? 6 : 0);
    else if (max === g)
        h = (b - r) / d + 2;
    else
        h = (r - g) / d + 4;
    return [h / 6, s, l];
}

function fromHsl(h, s, l) {
    const f = t => {
        t = (t + 1) % 1;
        const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
        const p = 2 * l - q;
        if (t < 1 / 6)
            return p + (q - p) * 6 * t;
        if (t < 1 / 2)
            return q;
        if (t < 2 / 3)
            return p + (q - p) * (2 / 3 - t) * 6;
        return p;
    };
    return [f(h + 1 / 3), f(h), f(h - 1 / 3)].map(v => Math.round(v * 255));
}
