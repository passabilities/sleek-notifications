# Sleek Notifications

A GNOME Shell extension that makes notifications quicker to read and get rid of.

GNOME shows one banner at a time and, with the pointer moving around, often keeps it on
screen until you click its close button. Sleek Notifications replaces that with banners
that leave on their own, stack, and can be swiped away, and gives the notification center
in the clock drop-down a matching redesign.

## Features

**Banners**

- Auto-dismiss after a set time (4 seconds by default) for every app
- Up to 3 on screen at once, newest on top, the rest slide into the notification list
- Swipe toward the screen edge to dismiss
- Hovering pauses every countdown; a thin bar shows the time left
- Slide-in motion, slight lift on hover, close button shown only on hover
- Accent color from each app's icon, or your system accent
- Critical alerts (low battery and the like) stay until dismissed
- Expanding a banner shows the full text and its action buttons

**Notification center**

- Header with a count, Do not disturb, and Clear all
- Cards that match the banners: app tile, colored edge, app and time, then title and body
- Notifications grouped by app under an open header with its count
- Swipe to dismiss in the list
- Quieter calendar, events, world clocks, and weather cards

Everything can be tuned or turned off in the extension's settings, which also has a
**Send test** button to preview a banner.

## Install

Requires GNOME Shell 51.

```sh
git clone git@github.com:passabilities/sleek-notifications.git
cd sleek-notifications
./install.sh
```

Then log out and back in once. GNOME on Wayland only discovers new extensions at login.

Options:

- `./install.sh --link` symlinks the checkout instead of copying it, handy for development
- `./install.sh --no-enable` installs without adding it to the enabled extensions

The installer turns off the Notification Timeout extension if present, since both change
the same banner timer.

Open the settings with:

```sh
gnome-extensions prefs sleek-notifications@passabilities.dev
```

## Development

`extension.js` is a small loader that imports `sleek.js` with a cache-busting query
string. GNOME Shell caches ES modules for the whole session, so this lets changes to
`sleek.js` and `stylesheet.css` load by turning the extension off and on, without logging
out:

```sh
gnome-extensions disable sleek-notifications@passabilities.dev
gnome-extensions enable sleek-notifications@passabilities.dev
```

Changes to `extension.js` itself still need a login. The settings window runs in a
separate process that also caches modules; after changing `prefs.js`, close it and stop
that process (`pkill -f org.gnome.Shell.Extensions`) before reopening.

## License

GPL-2.0-or-later. Parts of the banner logic are adapted from GNOME Shell.
