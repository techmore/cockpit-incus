#!/usr/bin/env bash
# Export every Incus instance to a backup folder, verify the archive, keep the newest few, and record the time on
# the instance (user.cockpit-incus.backup) so the cockpit-incus dashboard can show it in the Recovery column.
#
#   incus-backup.sh [--dry-run] [instance ...]
#
# Settings come from ~/.config/cockpit-incus/backup.conf (shell syntax), all optional:
#   DEST=$HOME/incus-backups   # where archives go; put it on a different drive/machine than the Incus pool
#   KEEP=3                     # archives kept per instance
#   MIN_FREE_GB=200            # refuse to start an export when the destination has less free space
#   EXCLUDE="name1 name2"      # instances to skip
#
# Notes: exports are live copies. A running container is file-consistent enough for most things, but a running
# database or virtual machine is only crash-consistent; take a database dump as well for anything important.
set -uo pipefail

conf=${CONF:-$HOME/.config/cockpit-incus/backup.conf}
DEST=$HOME/incus-backups KEEP=3 MIN_FREE_GB=200 EXCLUDE=""
# shellcheck disable=SC1090
[[ -f $conf ]] && . "$conf"

dry=0
[[ ${1:-} == --dry-run ]] && { dry=1; shift; }
mkdir -p "$DEST"
exec 9>"$DEST/.lock"
flock -n 9 || { echo "another backup run is in progress"; exit 0; }

log() { printf '%s %s\n' "$(date +%H:%M:%S)" "$*"; }
free_gb() { df -BG --output=avail "$DEST" | tail -1 | tr -dc '0-9'; }

if (( $# )); then names=("$@"); else mapfile -t names < <(incus list -c n -f csv); fi
failed=0 done_count=0 skipped=0
for name in "${names[@]}"; do
  if [[ " $EXCLUDE " == *" $name "* ]]; then log "skip $name (excluded)"; skipped=$((skipped + 1)); continue; fi
  type=$(incus list "$name" -c t -f csv 2>/dev/null | head -1)
  if (( $(free_gb) < MIN_FREE_GB )); then log "STOP: only $(free_gb) GB free in $DEST (< $MIN_FREE_GB)"; failed=$((failed + 1)); break; fi
  stamp=$(date +%Y%m%d-%H%M%S) dir="$DEST/$name"
  part="$dir/.$name-$stamp.tar.gz.partial" final="$dir/$name-$stamp.tar.gz"
  if (( dry )); then log "would export $name ($type) -> $final; keep $KEEP"; continue; fi
  mkdir -p "$dir"; start=$SECONDS
  if incus --quiet export "$name" "$part" --instance-only 2>"$dir/.last-error" \
     && gzip -t "$part" && tar -xzOf "$part" backup/index.yaml >/dev/null; then
    mv "$part" "$final"
    incus config set "$name" user.cockpit-incus.backup "$(date -Iseconds)"
    # shellcheck disable=SC2012
    ls -1t "$dir"/*.tar.gz 2>/dev/null | tail -n +"$((KEEP + 1))" | xargs -r rm -f --
    note=""; [[ $type == *VIRTUAL* ]] && note=" (virtual machine: crash-consistent only)"
    log "ok   $name  $(du -h "$final" | cut -f1)  $((SECONDS - start))s$note"
    done_count=$((done_count + 1))
  else
    log "FAIL $name: $(head -c 300 "$dir/.last-error" | tr '\n' ' ')"
    rm -f "$part"; failed=$((failed + 1))
  fi
done
log "finished: $done_count ok, $failed failed, $skipped skipped; $(free_gb) GB free in $DEST"
(( failed == 0 ))
