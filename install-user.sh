#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
DATA_HOME=${XDG_DATA_HOME:-"$HOME/.local/share"}
DEST="$DATA_HOME/cockpit/incus"

mkdir -p "$DEST"
cp -R "$SCRIPT_DIR/incus/." "$DEST/"
mkdir -p "$DATA_HOME/cockpit/projects"
cp -R "$SCRIPT_DIR/projects/." "$DATA_HOME/cockpit/projects/"
printf 'Installed cockpit-incus to %s\n' "$DEST"
printf 'Reload Cockpit in your browser. To remove it: rm -rf %s\n' "$DEST"
