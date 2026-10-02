# cockpit-incus

A Cockpit package for managing Incus instances on the Cockpit host. It uses the Cockpit JavaScript process API to invoke the local `incus` CLI as the signed-in account. It does not expose the Incus REST API to the browser or keep Incus credentials in the frontend.

## Current features

- Live instance list with state, type, IPv4, configured CPU and memory limits, root-disk size, profile, published proxy ports, and deployment-group tags
- Per-instance configuration details for profiles, base image, architecture, storage pool, additional devices, and current memory use
- Start, stop, inspect, and timestamped snapshot actions
- Launch Debian, Ubuntu, and Alpine containers or virtual machines
- Inspect a public GitHub repository and auto-detect a root Dockerfile or Compose stack, then deploy it inside an isolated Ubuntu VM
- Preview the generated cloud-init plan before launch; deployment code runs only after a trust confirmation
- Tag deployment VMs with `user.cockpit-incus.deployment`, and keep source, branch, and layout as instance metadata
- Map chosen guest ports to host loopback only; provide an optional hostname plus a Caddy reverse-proxy snippet for the operator to configure
- Sample per-instance Incus virtual NIC byte counters every 30 seconds and retain a browser-local 24-hour history, with 5-minute, 15-minute, 20-minute, 1-hour, 4-hour, 8-hour, and 24-hour views

### Telemetry and access counts

Incus exposes cumulative per-instance NIC counters. The module turns differences between samples into received/sent totals for the selected range. Sampling starts when the module is open; history is stored in that browser, not centrally. Pausing/closing Cockpit, clearing browser storage, or an instance restart can create gaps or reset an instance's counter baseline.

HTTP request totals are not currently collected. The host's Caddy configuration has no HTTP access-log source to query; network byte counters cannot determine request counts. A future access-log adapter needs an enabled Caddy JSON log source and a controlled, read-only path from the Cockpit session.

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

## Cockpit HTTPS note

Cockpit currently answers at `https://10.20.0.117:9090/`, but its certificate is self-signed for `localhost` and `127.0.0.1`, so browsers reject it for the LAN IP. Install a trusted Cockpit certificate with a Subject Alternative Name for the DNS name or IP used in the browser. Cockpit loads certificates from `/etc/cockpit/ws-certs.d/`; see the [official HTTPS guide](https://docs.cockpit-project.org/cockpit-guide/latest/guide/https.html). Do not publish port 9090 directly to the public internet to work around the warning.
