#!/bin/sh
# Install Sleek Notifications for the current user.
#
#   ./install.sh            copy the extension into place and enable it
#   ./install.sh --link     symlink this checkout instead (edits apply on reload)
#   ./install.sh --no-enable  install without touching the enabled list
set -eu

UUID="sleek-notifications@passabilities.dev"
SRC="$(cd "$(dirname "$0")" && pwd)"
DEST="${XDG_DATA_HOME:-$HOME/.local/share}/gnome-shell/extensions/$UUID"
FILES="metadata.json extension.js sleek.js prefs.js stylesheet.css schemas"

LINK=0
ENABLE=1
for arg in "$@"; do
  case "$arg" in
    --link) LINK=1 ;;
    --no-enable) ENABLE=0 ;;
    *) echo "Unknown option: $arg" >&2; exit 2 ;;
  esac
done

command -v glib-compile-schemas >/dev/null 2>&1 || {
  echo "glib-compile-schemas not found (install libglib2.0-bin)." >&2
  exit 1
}

mkdir -p "$(dirname "$DEST")"
if [ -d "$DEST" ] && [ "$(cd "$DEST" && pwd -P)" = "$(cd "$SRC" && pwd -P)" ]; then
  # Already a link to (or the same folder as) this checkout: nothing to copy.
  LINK=2
else
  rm -rf "$DEST"
fi

if [ "$LINK" -eq 2 ]; then
  :
elif [ "$LINK" -eq 1 ]; then
  ln -s "$SRC" "$DEST"
else
  mkdir -p "$DEST"
  for f in $FILES; do
    cp -r "$SRC/$f" "$DEST/"
  done
fi
glib-compile-schemas "$DEST/schemas"
echo "Installed to $DEST"

# Notification Timeout patches the same message tray timer; running both makes
# banners stick around again.
if command -v gnome-extensions >/dev/null 2>&1; then
  gnome-extensions disable notification-timeout@chlumskyvaclav.gmail.com 2>/dev/null || true
fi

if [ "$ENABLE" -eq 1 ] && command -v gsettings >/dev/null 2>&1; then
  # Writing the list directly works even before GNOME has discovered the
  # extension, which on Wayland only happens at login.
  current="$(gsettings get org.gnome.shell enabled-extensions)"
  case "$current" in
    *"'$UUID'"*) ;;
    "@as []") gsettings set org.gnome.shell enabled-extensions "['$UUID']" ;;
    *) gsettings set org.gnome.shell enabled-extensions "$(echo "$current" | sed "s/]\$/, '$UUID']/")" ;;
  esac
  echo "Enabled. Log out and back in once (Wayland) for GNOME to load it."
fi
