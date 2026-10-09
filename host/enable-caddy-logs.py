#!/usr/bin/env python3
"""Enable filtered Caddy logs with routing comparison and rollback on failure."""
import argparse
import copy
import json
import os
from pathlib import Path
import stat
import subprocess
import tempfile
import time

SNIPPET = 'import /etc/cockpit-incus/access-log.caddy'
SITE_IMPORT = 'import cockpit_incus_access'

def run(args, timeout=30):
    result = subprocess.run(args, capture_output=True, timeout=timeout, check=False)
    if result.returncode:
        # Adapted config and diagnostics can contain secrets; keep them private.
        raise RuntimeError('Command failed: ' + args[0] + ' ' + args[1])
    return result.stdout.decode()

def braces(line):
    quote = None
    escaped = False
    result = []
    for i, char in enumerate(line):
        if escaped:
            escaped = False
            continue
        if char == '\\':
            escaped = True
        elif quote:
            if char == quote:
                quote = None
        elif char in ('"', "'", '`'):
            quote = char
        elif char == '#':
            break
        elif char in '{}' and (i == 0 or line[i - 1].isspace()) and (i + 1 == len(line) or line[i + 1].isspace()):
            result.append((i, char))
    return result

def instrument(source):
    lines = source.splitlines(keepends=True)
    depth = 0
    inside_site = False
    block_start = None
    sites = []
    global_end = 0
    for index, line in enumerate(lines):
        for position, brace in braces(line):
            if brace == '{':
                if depth == 0:
                    prefix = line[:position].strip()
                    inside_site = bool(prefix and not prefix.startswith('('))
                    block_start = index
                depth += 1
            else:
                depth -= 1
                if depth < 0:
                    raise RuntimeError('Unexpected top-level Caddyfile layout; configure logging manually.')
                if depth == 0:
                    if inside_site:
                        sites.append((block_start, index))
                    elif block_start is not None and not lines[block_start].split('{', 1)[0].strip():
                        global_end = index + 1
                    inside_site = False
    if depth or not sites:
        raise RuntimeError('No ordinary Caddy site blocks found; configure logging manually.')
    additions = {}
    count = 0
    for start, end in sites:
        if not any(line.strip() == SITE_IMPORT for line in lines[start + 1:end]):
            additions.setdefault(start + 1, []).append('    ' + SITE_IMPORT + '\n')
            count += 1
    if not any(line.strip() == SNIPPET for line in lines):
        additions.setdefault(global_end, []).insert(0, '\n' + SNIPPET + '\n')
    output = []
    for index in range(len(lines) + 1):
        output.extend(additions.get(index, []))
        if index < len(lines):
            output.append(lines[index])
    return ''.join(output), count

def without_logging(config):
    result = copy.deepcopy(config)
    result.pop('logging', None)
    for server in result.get('apps', {}).get('http', {}).get('servers', {}).values():
        server.pop('logs', None)
    return result

def replace(path, content, attributes):
    with tempfile.NamedTemporaryFile(mode='w', dir=path.parent, prefix='.cockpit-incus-', delete=False) as stream:
        stream.write(content)
        stream.flush()
        os.fsync(stream.fileno())
        os.fchown(stream.fileno(), attributes.st_uid, attributes.st_gid)
        os.fchmod(stream.fileno(), stat.S_IMODE(attributes.st_mode))
        staged = stream.name
    os.replace(staged, path)

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', default='/etc/caddy/Caddyfile')
    parser.add_argument('--refresh', action='store_true', help='Validate and restart when the snippet has changed.')
    args = parser.parse_args()
    if os.geteuid() != 0:
        raise RuntimeError('Run this helper as root.')
    path = Path(args.config)
    if path.is_symlink():
        raise RuntimeError('Use the actual Caddyfile path, not a symlink.')
    original = path.read_text()
    candidate, added = instrument(original)
    if candidate == original and not args.refresh:
        print('Managed Caddy access logging is already configured.')
        return
    before = json.loads(run(['caddy', 'adapt', '--config', str(path)]))
    staged = path.with_name(path.name + '.cockpit-incus-candidate')
    if staged.exists() or staged.is_symlink():
        raise RuntimeError('A previous candidate exists; inspect it before continuing.')
    backup_dir = Path('/var/backups/cockpit-incus')
    backup_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
    backup = backup_dir / ('Caddyfile.' + time.strftime('%Y%m%dT%H%M%S') + '.' + str(os.getpid()))
    attributes = path.stat()
    try:
        with staged.open('x') as stream:
            stream.write(candidate)
            os.fchmod(stream.fileno(), 0o640)
        # Validate as the service user so the private log file belongs to Caddy.
        import grp
        os.chown(staged, 0, grp.getgrnam('caddy').gr_gid)
        after = json.loads(run(['caddy', 'adapt', '--config', str(staged), '--adapter', 'caddyfile']))
        if without_logging(before) != without_logging(after):
            raise RuntimeError('Candidate changes routing or other non-logging settings; activation refused.')
        run(['runuser', '-u', 'caddy', '--', 'caddy', 'validate', '--config', str(staged), '--adapter', 'caddyfile'])
        with backup.open('x') as stream:
            stream.write(original)
            os.fchmod(stream.fileno(), 0o600)
            stream.flush()
            os.fsync(stream.fileno())
        if path.read_text() != original:
            raise RuntimeError('Caddyfile changed during preparation; activation refused.')
        replace(path, candidate, attributes)
        try:
            run(['systemctl', 'restart', 'caddy'], timeout=45)
            run(['systemctl', 'is-active', '--quiet', 'caddy'])
        except Exception:
            replace(path, original, attributes)
            run(['systemctl', 'restart', 'caddy'], timeout=45)
            raise RuntimeError('Logging activation failed; original Caddyfile restored.')
        print(f'Enabled filtered access logging for {added} sites. Routing unchanged. Private backup: {backup}')
    finally:
        staged.unlink(missing_ok=True)

if __name__ == '__main__':
    try:
        main()
    except (RuntimeError, OSError, ValueError, subprocess.TimeoutExpired) as error:
        print(str(error))
        raise SystemExit(1)
