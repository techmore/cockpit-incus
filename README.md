# cockpit-incus

A Cockpit package for managing Incus instances on the Cockpit host. It uses the Cockpit JavaScript process API to invoke the local `incus` CLI as the signed-in account. It does not expose the Incus REST API to the browser or keep Incus credentials in the frontend.

## Current features

- Live instance list with state, type, IPv4, configured CPU and memory limits, root-disk size, profile, published proxy ports, and deployment-group tags
- CPU and RAM averages for the selected window; root filesystem file use sampled every five minutes. Disk percentages compare use with the configured root size and are estimates unless the storage backend enforces that size. Incus memory use includes filesystem cache.
- Per-instance configuration details for profiles, base image, architecture, storage pool, additional devices, and current memory use
- Start, stop, inspect, and timestamped snapshot actions
- Launch Debian, Ubuntu, and Alpine containers or virtual machines
- Inspect a public GitHub repository and auto-detect a root Dockerfile or Compose stack, then deploy it inside an isolated Ubuntu VM
- Preview the generated cloud-init plan before launch; deployment code runs only after a trust confirmation
- Tag deployment VMs with `user.cockpit-incus.deployment`, and keep source, branch, and layout as instance metadata
- Map chosen guest ports to host loopback only; provide an optional hostname plus a Caddy reverse-proxy snippet for the operator to configure
- Continuous host collection of per-instance NIC bytes, CPU and RAM, with 5-minute, 15-minute, 20-minute, 1-hour, 4-hour, 8-hour, and 24-hour views
- Configured Caddy domain inventory, clickable service links, DNS answers, guest owners, upstream ports and redirect aliases
- External HTTP request totals, request/response body bytes, 5xx responses, average response duration and charts, by domain and uniquely mapped guest

### Telemetry and access counts

The host collector runs every 30 seconds, retaining 24 hours in a private SQLite database. Cockpit reads a root-owned aggregate JSON report without elevated privileges. Collection continues when the page is closed. The selected window applies to domain hits, bandwidth and instance CPU/RAM averages. The page shows available history while new installations warm up; unavailable or stale collection is labeled. NIC totals include internal traffic and skip counter resets and collection gaps. Without the collector, the existing browser sampler remains available.

HTTP totals require Caddy access logging. External means a public client address observed by Caddy or an explicitly configured public ingress gateway, not a unique human visitor. For NAT gateways that hide the client address, set a narrow `external_ingress_cidrs` list only for verified public ingress peers. The report shows direct public peers and gateway requests separately; gateway requests can include gateway health checks and clients using the public route. SER8 uses its WireGuard peer `192.168.3.1/32` for this public ingress. Private, loopback and Tailscale clients are counted separately. Forwarded headers are ignored by default; operators behind a trusted reverse proxy must deliberately configure `trusted_proxy_cidrs` and retain only the necessary forwarded-address header in their custom log format. The supplied format deletes all request headers, response headers and request URIs. Access logs live in a directory readable only by Caddy and root, including rotated files. The private database stores only minute aggregates, domain names and guest attribution; the public report contains no client addresses or raw requests.

HTTP windows have minute resolution. Upload/download figures are request/response **body bytes**, excluding TLS, TCP and header overhead. Streaming requests are counted when they complete, so live NIC totals can rise before HTTP totals. Average response duration includes completed streams. If one hostname uses different listener ports for different guests, request ownership follows the port. Shared listeners with multiple guest owners retain domain totals and do not assign those hits to one guest. Guest ownership is recorded when requests are collected. Logs are rotated at 50 MiB, with four retained uncompressed rotations for up to 48 hours; the collector catches up incrementally.

Domain discovery reads Caddy's adapted configuration and maps upstream guest addresses or Incus host proxy listeners. Redirect aliases point at their destination guest. Unmapped upstreams and host services are labeled. DNS answers are refreshed every five minutes, using the host resolver; this does not enumerate DNS aliases that have no configured Caddy route. All Incus projects are collected by default, while the instance management table follows the signed-in account's current project. The report is readable by local Cockpit users, so deployments that isolate projects between mutually untrusted accounts should restrict its file permissions and configure a specific `projects` list.

GitHub deployments currently support public HTTPS repositories with a Dockerfile at repository root, or a Compose file at repository root. Private repositories, monorepo subdirectories, arbitrary buildpacks, automatic DNS edits, and automatic Caddy edits are not supported yet. Detection uses GitHub’s public repository and contents APIs, so the Cockpit host needs outbound access to `api.github.com`. The wizard intentionally launches one Ubuntu VM per deployment; Compose services run together inside that VM and carry one deployment tag. Proxy listeners bind to host loopback only. Review repository build scripts before approving them.

The module does not delete instances, enable privileged Incus containers, publish ports on all host interfaces, or configure host mounts.

## Install for the signed-in user

On the Incus host, check out this repository, then run:

```sh
./install-user.sh
```

Reload Cockpit. The Incus entry appears in the System menu. For system-wide installation, copy the `incus/` directory to `/usr/local/share/cockpit/incus/` and make it readable by Cockpit users.

The host must have Cockpit and the Incus CLI installed. The signed-in Cockpit account must already have permission to access Incus. The module intentionally does not try to add accounts to privileged groups or use `sudo` behind the user's back.

For development, the same package can be symlinked into `~/.local/share/cockpit/incus`; Cockpit does not cache packages installed in the user's data directory. See the [Cockpit package guide](https://docs.cockpit-project.org/cockpit-guide/main/guide/packages.html) and [starter kit](https://github.com/cockpit-project/starter-kit).

## Install continuous host telemetry

Requires Linux with systemd, Python 3, Incus, Caddy, `ip` and `getent`. Run on the Incus host:

```sh
sudo ./install-host.sh
sudo /usr/local/libexec/cockpit-incus/enable-caddy-logs.py
```

The installer enables two timers: resource/access collection every 30 seconds and bounded root-file scans every five minutes. The log helper adds the supplied snippet to ordinary Caddy site blocks, validates the candidate and confirms the adapted routing is unchanged. It keeps a private rollback copy. It then restarts Caddy, which briefly interrupts proxy service; failed activation restores the original configuration. Configure logging manually instead if your Caddyfile uses an unusual top-level layout. Re-running the helper is safe once its imports are present; use `--refresh` when updating the snippet.

Paths:

- `/etc/cockpit-incus/collector.json`: root-only source paths, optional project list and trusted proxy CIDRs
- `/usr/local/libexec/cockpit-incus/`: root-owned collector and log helper
- `/var/lib/cockpit-incus/metrics.sqlite`: root-only counters, cursor positions and aggregates
- `/var/cache/cockpit-incus/telemetry.json`: read-only aggregate report for Cockpit
- `/var/log/caddy/cockpit-incus/access.jsonl`: private filtered Caddy access log
- `cockpit-incus-collector.timer` / `cockpit-incus-disks.timer`: systemd timers

No historical HTTP traffic is backfilled before logging is enabled. Root-file scans use two workers and a 20-second guest timeout. To remove collection, disable both timers, remove the managed imports from Caddy and reload/restart it, then remove the installed units and collector directories.

## Cockpit HTTPS note

Cockpit currently answers at `https://10.20.0.117:9090/`, but its certificate is self-signed for `localhost` and `127.0.0.1`, so browsers reject it for the LAN IP. Install a trusted Cockpit certificate with a Subject Alternative Name for the DNS name or IP used in the browser. Cockpit loads certificates from `/etc/cockpit/ws-certs.d/`; see the [official HTTPS guide](https://docs.cockpit-project.org/cockpit-guide/latest/guide/https.html). Do not publish port 9090 directly to the public internet to work around the warning.
