#!/bin/sh
# Install the shared dashboard and its private, SQLite-backed visitor service.
set -eu
[ "$(id -u)" -eq 0 ] || { printf 'Run as root on the Cockpit/Incus host.\n' >&2; exit 1; }
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
command -v python3 >/dev/null
command -v incus >/dev/null
if [ ! -x /usr/local/bin/goatcounter ]; then
    candidate=$(mktemp -d /var/tmp/project-analytics.XXXXXX)
    trap 'rm -rf "$candidate"' EXIT HUP INT TERM
    curl -fsSL https://github.com/arp242/goatcounter/releases/download/v2.7.0/goatcounter-v2.7.0-linux-amd64.gz -o "$candidate/goatcounter.gz"
    printf '%s  %s\n' 98d221cb9c8ef2bf76d8daa9cca647839f8d8b0bb5bc7400ff9337c5da834511 "$candidate/goatcounter.gz" | sha256sum -c -
    gzip -dc "$candidate/goatcounter.gz" > "$candidate/goatcounter"
    install -m 0755 "$candidate/goatcounter" /usr/local/bin/goatcounter
fi
/usr/local/bin/goatcounter version | grep -q 'v2.7.0' || { printf 'This dashboard adapter requires GoatCounter v2.7.0.\n' >&2; exit 1; }
getent passwd project-analytics >/dev/null || useradd --system --home-dir /var/lib/project-analytics --shell /usr/sbin/nologin project-analytics
install -d -o project-analytics -g project-analytics -m 0700 /var/lib/project-analytics
install -d -o root -g project-analytics -m 0750 /etc/project-analytics
install -d -o root -g root -m 0755 /usr/local/libexec/cockpit-incus/projects /usr/local/share/cockpit/projects /var/cache/cockpit-incus /etc/cockpit-incus
install -d -o root -g root -m 0700 /var/lib/cockpit-incus /var/backups/project-analytics
install -m 0755 "$ROOT/host/projects/ingest.py" "$ROOT/host/projects/collect.py" "$ROOT/host/projects/setup.py" "$ROOT/host/projects/backup.py" /usr/local/libexec/cockpit-incus/projects/
install -m 0644 "$ROOT/host/projects/tracker.js" /usr/local/libexec/cockpit-incus/projects/tracker.js
install -m 0644 "$ROOT/host/projects/routes.caddy" /etc/cockpit-incus/projects-routes.caddy
install -m 0644 "$ROOT/projects/manifest.json" "$ROOT/projects/index.html" "$ROOT/projects/projects.js" "$ROOT/projects/admin-ui.css" /usr/local/share/cockpit/projects/
if [ ! -f /etc/cockpit-incus/projects.json ]; then
    printf '%s\n' '{"discover_routes":true,"applications":[]}' > /etc/cockpit-incus/projects.json
    chmod 0600 /etc/cockpit-incus/projects.json
fi
python3 /usr/local/libexec/cockpit-incus/projects/setup.py
for unit in "$ROOT"/host/projects/*.service "$ROOT"/host/projects/*.timer; do
    install -m 0644 "$unit" /etc/systemd/system/
done
systemctl daemon-reload
systemctl enable --now project-analytics-goatcounter.service project-analytics-ingest.service cockpit-projects-collector.timer project-analytics-backup.timer
systemctl restart project-analytics-ingest.service
systemctl start cockpit-projects-collector.service
printf 'Projects dashboard installed. Import projects-routes.caddy globally and project_analytics inside registered Caddy sites, then deploy the page tracking hooks.\n'
