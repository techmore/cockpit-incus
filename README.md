# cockpit-incus

A Cockpit package for managing Incus instances on the Cockpit host. It uses the Cockpit JavaScript process API to invoke the local `incus` CLI as the signed-in account. It does not expose the Incus REST API to the browser or keep Incus credentials in the frontend.

## Current features

- Live instance list, state, type, IPv4, totals, and name filtering
- Start and gracefully stop instances
- Timestamped snapshots with a confirmation step
- Instance inspection using `incus info`
- Launch Debian 12, Ubuntu 24.04, and Alpine 3.20 containers or VMs
- Uses the host's default Incus profile and sets 2 CPU / 2 GiB memory limits

The module does not delete instances, configure host mounts, or enable privileged containers.

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
