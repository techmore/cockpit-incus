#!/bin/sh
# Root installation of a fixed collector. Browser users get only aggregate JSON.
set -eu
[ "$(id -u)" -eq 0 ] || { printf 'Run this installer as root.\n' >&2; exit 1; }
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
command -v python3 >/dev/null
command -v incus >/dev/null
command -v caddy >/dev/null
install -d -m 0755 /usr/local/libexec/cockpit-incus /etc/cockpit-incus /var/cache/cockpit-incus
install -d -m 0700 /var/lib/cockpit-incus
install -d -o caddy -g caddy -m 0700 /var/log/caddy/cockpit-incus
install -m 0755 "$ROOT/host/collector.py" /usr/local/libexec/cockpit-incus/collector.py
install -m 0755 "$ROOT/host/enable-caddy-logs.py" /usr/local/libexec/cockpit-incus/enable-caddy-logs.py
install -m 0644 "$ROOT/host/access-log.caddy" /etc/cockpit-incus/access-log.caddy
for name in cockpit-incus-collector.service cockpit-incus-collector.timer cockpit-incus-disks.service cockpit-incus-disks.timer; do
    install -m 0644 "$ROOT/host/$name" "/etc/systemd/system/$name"
done
if [ ! -f /etc/cockpit-incus/collector.json ]; then
    printf '%s\n' '{"caddy_config":"/etc/caddy/Caddyfile","access_log":"/var/log/caddy/cockpit-incus/access.jsonl","trusted_proxy_cidrs":[],"external_ingress_cidrs":[]}' > /etc/cockpit-incus/collector.json
    chmod 0600 /etc/cockpit-incus/collector.json
fi
chown -R root:root /usr/local/libexec/cockpit-incus /etc/cockpit-incus
chmod -R go-w /usr/local/libexec/cockpit-incus /etc/cockpit-incus
systemctl daemon-reload
systemctl enable --now cockpit-incus-collector.timer cockpit-incus-disks.timer
systemctl start cockpit-incus-collector.service
printf 'Installed continuous telemetry. Enable the supplied Caddy log snippet for HTTP counts.\n'
