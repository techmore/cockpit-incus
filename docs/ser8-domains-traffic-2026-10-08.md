# SER8 domain and traffic telemetry deployment

Date: 2026-10-08. Feature source commit: `4c0e465`.

## Installed

- Cockpit package: `/home/sdolbec/.local/share/cockpit/incus`
- Root-owned collector and log helper: `/usr/local/libexec/cockpit-incus/`
- Private state: `/var/lib/cockpit-incus/metrics.sqlite`
- Read-only aggregate report: `/var/cache/cockpit-incus/telemetry.json`
- Filtered access logs and rotations: `/var/log/caddy/cockpit-incus/` (Caddy-owned, mode 0700)
- Resource/access timer: 30 seconds; disk timer: five minutes
- Caddy 2.6.2: eight site blocks, nine distinct hostnames

The logging helper confirmed adapted HTTP routes, TLS and non-logging settings were unchanged. Caddy's admin API remains disabled. Caddy required a brief restart to activate logs. Private rollback copies are under `/var/backups/cockpit-incus/`.

## Domain ownership

| Domain / listener | Incus guest | Route |
| --- | --- | --- |
| `daedalus.cybersecuritypilot.org:443` | `daedalus-prod` | Host proxy 18000 → guest 8000 |
| `herbalhealers.cybersecuritypilot.org:443` | `rupert` | Guest 3000 |
| `homeboard.stoverparc.org:443` | `homeboard` | Redirect to `tasks.stoverparc.org` |
| `rupert.cybersecuritypilot.org:443` | `rupert` | Guest 3000 |
| `rupert.stoverparc.org:443` | `rupert` | Guest 3000 |
| `sonder.stoverparc.org:443` | `sonder` | Host proxy 8098 → guest 8098 |
| `stoverparc.org:443` | `swartzit` | Redirect to `swartzit.stoverparc.org` |
| `stoverparc.org:8096` | `sonder` | Host proxy 8098 → guest 8098 |
| `swartzit.stoverparc.org:443` | `swartzit` | Guest 4173 |
| `tasks.stoverparc.org:443` | `homeboard` | Guest 4180 for auth routes, 8790 for app routes |

All current guests are in the `default` project. The collector found eleven instances, ten running. Root-file sampling completed for all ten running instances. CPU/RAM averages and network deltas were populated after successive collections.

## Ingress accounting

Public HTTP requests reach SER8 through WireGuard peer `192.168.3.1`, which hides the original client address. Observed public requests to the app domains appeared at Caddy from this peer. SER8's collector config explicitly classifies only `192.168.3.1/32` as public gateway ingress. UI totals distinguish gateway requests, direct public peers, local peers and unknown sources. Gateway requests can include gateway health checks and clients using the public route; these are request totals, not unique visitors.

Forwarded headers are not trusted. Request headers, response headers and request URIs are removed from access logs. The aggregate database/report contains no client addresses. The database is mode 0600, and the signed-in `sdolbec` account can read the aggregate report.

Initial filtered logs were recounted after identifying the gateway, retaining resource history. Log cursors and HTTP minute buckets commit together. NIC traffic includes internal traffic; HTTP totals count completed requests and body bytes. Long streams appear in HTTP totals when they complete.

## Deployment observations

- Caddy, Cockpit socket, Incus and both collector timers active
- Both collector services reported `Result=success`
- Nine domain rows and eleven instance records available; report had no source errors
- Access records processed with zero malformed records and no backlog
- Public Swartzit and Homeboard returned HTTP 200; Sonder returned its authentication-required HTTP 401
- JavaScript, Python and shell syntax checks passed; Git whitespace check passed

No local app runtime was started. History starts with this deployment and continues while Cockpit is closed. DNS aliases without configured Caddy routes are not enumerated; disk percentages remain estimates where the storage backend does not enforce the assigned quota. This deployment record describes host observations and syntax checks; no automated test suite or authenticated browser pass was run.
