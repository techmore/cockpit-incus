#!/usr/bin/env python3
"""Local Incus/Caddy inventory and aggregate telemetry. No raw requests are stored."""
import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
from contextlib import closing
import fcntl
import fnmatch
import ipaddress
import json
import math
import os
from pathlib import Path
import re
import sqlite3
import subprocess
import tempfile
import time
from urllib.parse import urlsplit

ROUTE_VERSION = 2
WINDOWS = (300, 900, 1200, 3600, 14400, 28800, 86400)
STATE = Path('/var/lib/cockpit-incus')
REPORT = Path('/var/cache/cockpit-incus/telemetry.json')
CONFIG = Path('/etc/cockpit-incus/collector.json')
SCHEMA = '''
CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS baseline(key TEXT PRIMARY KEY,value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS resource(t REAL,key TEXT,status TEXT,dt REAL,cpu REAL,capacity REAL,
 memory INTEGER,memory_total INTEGER,rx INTEGER,tx INTEGER,PRIMARY KEY(t,key));
CREATE INDEX IF NOT EXISTS resource_time ON resource(t);
CREATE TABLE IF NOT EXISTS http(minute INTEGER,host TEXT,owner TEXT,scope TEXT,hits INTEGER,
 received INTEGER,sent INTEGER,errors4 INTEGER,errors5 INTEGER,duration REAL,
 PRIMARY KEY(minute,host,owner,scope));
CREATE INDEX IF NOT EXISTS http_time ON http(minute);
CREATE TABLE IF NOT EXISTS cursor(identity TEXT PRIMARY KEY,offset INTEGER,t REAL);
CREATE TABLE IF NOT EXISTS disk(key TEXT PRIMARY KEY,t REAL,bytes INTEGER,error TEXT);
'''

def command(args, timeout=15):
    result = subprocess.run(args, capture_output=True, timeout=timeout, check=False)
    if result.returncode:
        raise RuntimeError('Host command failed: ' + args[0])
    return result.stdout.decode()

def metadata(db, key, fallback=None):
    row = db.execute('SELECT value FROM meta WHERE key=?', (key,)).fetchone()
    return json.loads(row[0]) if row else fallback

def save_metadata(db, key, value):
    db.execute('INSERT INTO meta VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
               (key, json.dumps(value, separators=(',', ':'))))

def incus_inventory(config):
    projects = config.get('projects')
    if projects is None:
        projects = [item['name'] for item in json.loads(command(['incus', '--force-local', 'project', 'list', '--format=json']))]
    result = []
    for project in projects:
        for item in json.loads(command(['incus', '--force-local', '--project', project, 'list', '--format=json'])):
            item['_project'] = project
            item['_key'] = project + '/' + item['name']
            result.append(item)
    return result

def addresses(item):
    return {a['address'] for n in ((item.get('state') or {}).get('network') or {}).values()
            for a in n.get('addresses', []) if a.get('scope') == 'global'}

def split_endpoint(value):
    value = str(value or '')
    if value.startswith(('tcp:', 'udp:')):
        value = value[4:]
    if value.startswith(('unix', '/')) or '{' in value:
        return None, None
    if value.startswith('['):
        match = re.fullmatch(r'\[([^]]+)\]:(\d+)', value)
        return (match[1], int(match[2])) if match else (None, None)
    host, sep, port = value.rpartition(':')
    return (host.lower(), int(port)) if sep and port.isdigit() else (None, None)

def hostname(value):
    host = str(value or '').strip().lower().rstrip('.')
    if host.startswith('['):
        return host.split(']', 1)[0][1:]
    if host.count(':') == 1:
        host = host.split(':', 1)[0]
    return host if re.fullmatch(r'[a-z0-9*_.:-]+', host) else ''

def host_addresses():
    return {a['local'] for interface in json.loads(command(['ip', '-j', 'address', 'show']))
            for a in interface.get('addr_info', [])} | {'localhost', '127.0.0.1', '::1'}

def route_inventory(config, items):
    adapted = json.loads(command(['caddy', 'adapt', '--config', config.get('caddy_config', '/etc/caddy/Caddyfile')]))
    local = host_addresses()
    address_owners = {}
    proxies = []
    for item in items:
        for address in addresses(item):
            address_owners.setdefault(address, []).append(item['_key'])
        for device in (item.get('expanded_devices') or item.get('devices') or {}).values():
            if device.get('type') == 'proxy' and str(device.get('listen', '')).startswith('tcp:'):
                host, port = split_endpoint(device.get('listen'))
                _, guest_port = split_endpoint(device.get('connect'))
                proxies.append((host, port, item['_key'], guest_port))
    domains = {}
    def domain(name, listeners):
        if name not in domains:
            domains[name] = {'name': name, 'listeners': [], 'targets': [], 'redirects': [], 'redirect_routes': [], 'instances': []}
        entry = domains[name]
        entry['listeners'] = sorted(set(entry['listeners'] + listeners))
        return entry
    def walk(value, names, paths, listeners):
        if isinstance(value, list):
            for entry in value:
                walk(entry, names, paths, listeners)
        elif isinstance(value, dict):
            matches = value.get('match', [])
            matched_names = sorted({hostname(h) for m in matches for h in m.get('host', []) if hostname(h)})
            names = matched_names or names
            paths = sorted({p for m in matches for p in m.get('path', [])}) or paths
            for name in names:
                entry = domain(name, listeners)
                if value.get('handler') == 'reverse_proxy':
                    for upstream in value.get('upstreams', []):
                        dial = upstream.get('dial', '')
                        host, port = split_endpoint(dial)
                        owners = [(key, port, 'Guest address') for key in address_owners.get(host, [])]
                        if host in local:
                            owners += [(key, guest_port, 'Host proxy') for bind, bind_port, key, guest_port in proxies
                                       if bind_port == port and (bind == host or (host == 'localhost' and bind in ('127.0.0.1', '::1')) or bind in ('0.0.0.0', '::'))]
                        target = {'upstream': dial, 'paths': paths, 'listeners': listeners, 'owners': sorted({key for key, _, _ in owners}),
                                  'guest_ports': sorted({p for _, p, _ in owners if p is not None}),
                                  'via': owners[0][2] if owners else ('Host service' if host in local else 'Unmapped upstream')}
                        if target not in entry['targets']:
                            entry['targets'].append(target)
                if value.get('handler') == 'static_response':
                    for location in value.get('headers', {}).get('Location', []):
                        parsed = urlsplit(re.sub(r'\{[^}]+\}', '', location))
                        destination = hostname(parsed.hostname)
                        if destination:
                            redirect = {'host': destination, 'port': parsed.port or (443 if parsed.scheme == 'https' else 80), 'listeners': listeners}
                            if destination not in entry['redirects']:
                                entry['redirects'].append(destination)
                            if redirect not in entry['redirect_routes']:
                                entry['redirect_routes'].append(redirect)
            for child in value.values():
                if isinstance(child, (dict, list)):
                    walk(child, names, paths, listeners)
    for server in adapted.get('apps', {}).get('http', {}).get('servers', {}).values():
        walk(server.get('routes', []), [], [], server.get('listen', []))
    # Redirect aliases retain a distinct domain row and point at their final guest.
    def listener_ports(listeners):
        return {port for listener in listeners for _, port in [split_endpoint(listener)] if port}
    def owners(name, visited, port=None):
        if name in visited or name not in domains:
            return set()
        entry = domains[name]
        result = {key for target in entry['targets'] if port is None or port in listener_ports(target['listeners'])
                  for key in target['owners']}
        for redirected in entry['redirect_routes']:
            if port is None or port in listener_ports(redirected['listeners']):
                result |= owners(redirected['host'], visited | {name}, redirected['port'])
        return result
    for name, entry in domains.items():
        entry['instances'] = sorted(owners(name, set()))
        ports = sorted(listener_ports(entry['listeners']))
        entry['bindings'] = [{'port': port, 'instances': sorted(owners(name, set(), port))} for port in ports]
        preferred = 443 if 443 in ports else 80 if 80 in ports else next(iter(ports), None)
        secure = preferred != 80
        authority = '[' + name + ']' if ':' in name else name
        suffix = ':' + str(preferred) if preferred and preferred not in (80, 443) else ''
        entry['url'] = ('https://' if secure else 'http://') + authority + suffix if '*' not in name else None
        entry['dns'] = {'addresses': [], 'status': 'Wildcard' if '*' in name else 'Unresolved'}
    def resolve(entry):
        if '*' in entry['name']:
            return
        try:
            text = command(['getent', 'ahosts', entry['name']], timeout=2)
            entry['dns'] = {'addresses': sorted({str(ipaddress.ip_address(line.split()[0])) for line in text.splitlines() if line.split()}), 'status': 'Resolved'}
        except (RuntimeError, OSError, ValueError, subprocess.TimeoutExpired):
            pass
    with ThreadPoolExecutor(max_workers=4) as pool:
        list(pool.map(resolve, domains.values()))
    logging = any(s.get('logs') is not None for s in adapted.get('apps', {}).get('http', {}).get('servers', {}).values())
    return sorted(domains.values(), key=lambda x: x['name']), logging

def capacity(config):
    value = str(config.get('limits.cpu', ''))
    if value.isdigit():
        return int(value)
    if re.fullmatch(r'\d+(?:-\d+)?(?:,\d+(?:-\d+)?)*', value):
        return sum(int(p.split('-')[-1]) - int(p.split('-')[0]) + 1 for p in value.split(','))
    return None

def sample_resources(db, items, now):
    for item in items:
        state = item.get('state') or {}
        network = state.get('network') or {}
        counters = [n.get('counters') or {} for name, n in network.items() if name != 'lo']
        running = item.get('status', '').lower() == 'running'
        current = {'t': now, 'cpu': (state.get('cpu') or {}).get('usage'),
                   'rx': sum(n.get('bytes_received') or 0 for n in counters) if counters else None,
                   'tx': sum(n.get('bytes_sent') or 0 for n in counters) if counters else None,
                   'epoch': [item.get('created_at'), state.get('pid')], 'running': running}
        row = db.execute('SELECT value FROM baseline WHERE key=?', (item['_key'],)).fetchone()
        previous = json.loads(row[0]) if row else None
        dt = now - previous['t'] if previous else 0
        valid = bool(previous and previous['running'] and running and previous['epoch'] == current['epoch'] and 0 < dt <= 90)
        cpu = rx = tx = None
        if valid:
            if current['cpu'] is not None and previous['cpu'] is not None and current['cpu'] >= previous['cpu']:
                cpu = (current['cpu'] - previous['cpu']) / (dt * 1e9)
            if all(current[k] is not None and previous[k] is not None and current[k] >= previous[k] for k in ('rx', 'tx')):
                rx, tx = current['rx'] - previous['rx'], current['tx'] - previous['tx']
        elif not running:
            cpu, rx, tx = 0, 0, 0
        memory = state.get('memory') or {}
        db.execute('INSERT OR REPLACE INTO resource VALUES(?,?,?,?,?,?,?,?,?,?)',
                   (now, item['_key'], item.get('status'), min(30, dt) if not valid else dt, cpu,
                    capacity(item.get('expanded_config') or item.get('config') or {}),
                    memory.get('usage') if running else 0, memory.get('total'), rx, tx))
        db.execute('INSERT INTO baseline VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
                   (item['_key'], json.dumps(current)))

def client_scope(request, trusted, ingress):
    value = request.get('client_ip') or request.get('remote_ip') or request.get('remote_addr', '')
    try:
        try:
            peer = ipaddress.ip_address(value)
        except ValueError:
            peer = ipaddress.ip_address(split_endpoint(value)[0])
        # Forwarded headers are ignored unless the operator explicitly trusts
        # the direct peer. Our default filtered logs contain no headers.
        if any(peer in network for network in trusted):
            chain = request.get('headers', {}).get('X-Forwarded-For', [])
            hops = [ipaddress.ip_address(v.strip()) for value in chain for v in value.split(',')]
            while hops and any(hops[-1] in network for network in trusted):
                hops.pop()
            if hops:
                peer = hops[-1]
        return 'external' if peer.is_global else 'gateway' if any(peer in network for network in ingress) else 'local'
    except (ValueError, TypeError):
        return 'unknown'

def collect_access(db, config, domains, now):
    log = Path(config.get('access_log', '/var/log/caddy/cockpit-incus/access.jsonl'))
    def modified(path):
        try:
            return path.stat().st_mtime
        except OSError:
            return 0
    files = sorted({log, *log.parent.glob(log.stem + '-*' + log.suffix)}, key=modified)
    trusted = [ipaddress.ip_network(n) for n in config.get('trusted_proxy_cidrs', [])]
    ingress = [ipaddress.ip_network(n) for n in config.get('external_ingress_cidrs', [])]
    registry = {d['name']: d for d in domains}
    processed = malformed = 0
    remaining = 32 * 1024 * 1024
    backlog = False
    for path in files:
        if not path.is_file() or path.is_symlink():
            continue
        try:
            stream = path.open('rb')
        except FileNotFoundError:
            continue
        with stream:
            stat = os.fstat(stream.fileno())
            identity = str(stat.st_dev) + ':' + str(stat.st_ino)
            row = db.execute('SELECT offset FROM cursor WHERE identity=?', (identity,)).fetchone()
            offset = row[0] if row and row[0] <= stat.st_size else 0
            if stat.st_size == offset:
                continue
            stream.seek(offset)
            while remaining > 0:
                start = stream.tell()
                line = stream.readline(1024 * 1024 + 1)
                if not line:
                    break
                if not line.endswith(b'\n') and len(line) > 1024 * 1024:
                    # Never let a malformed oversized record block the tail.
                    while line and not line.endswith(b'\n'):
                        line = stream.readline(1024 * 1024 + 1)
                    offset = stream.tell()
                    malformed += 1
                    remaining -= offset - start
                    continue
                if not line.endswith(b'\n'):
                    stream.seek(start)
                    break
                remaining -= len(line)
                offset = stream.tell()
                try:
                    entry = json.loads(line)
                    if not str(entry.get('logger', '')).startswith('http.log.access'):
                        continue
                    t = float(entry['ts'])
                    if not math.isfinite(t) or t < now - 86400 or t > now + 60:
                        continue
                    request = entry.get('request') or {}
                    name = hostname(request.get('host'))
                    if not name:
                        continue
                    domain = registry.get(name)
                    if domain is None:
                        domain = next((d for d in domains if '*' in d['name'] and fnmatch.fnmatchcase(name, d['name'])), None)
                    # A hostname can route to different guests on different ports.
                    # For automatic HTTP-to-HTTPS redirects use the HTTPS owner.
                    port = split_endpoint(request.get('host'))[1] or (443 if request.get('tls') is not None else 80)
                    bindings = domain.get('bindings', []) if domain else []
                    binding = next((b for b in bindings if b['port'] == port), None)
                    if binding is None and port == 80:
                        binding = next((b for b in bindings if b['port'] == 443), None)
                    mapped = binding['instances'] if binding is not None else domain['instances'] if domain else []
                    owner = mapped[0] if len(mapped) == 1 else ''
                    scope = client_scope(request, trusted, ingress)
                    status = int(entry.get('status', 0))
                    duration = max(0, float(entry.get('duration', 0)))
                    if not math.isfinite(duration):
                        duration = 0
                    values = (int(t // 60) * 60, name, owner, scope, 1,
                              max(0, int(entry.get('bytes_read', 0))), max(0, int(entry.get('size', 0))),
                              int(400 <= status < 500), int(500 <= status < 600), duration)
                    db.execute('''INSERT INTO http VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(minute,host,owner,scope)
                        DO UPDATE SET hits=hits+excluded.hits,received=received+excluded.received,
                        sent=sent+excluded.sent,errors4=errors4+excluded.errors4,
                        errors5=errors5+excluded.errors5,duration=duration+excluded.duration''', values)
                    processed += 1
                except (ValueError, TypeError, KeyError):
                    malformed += 1
        db.execute('INSERT INTO cursor VALUES(?,?,?) ON CONFLICT(identity) DO UPDATE SET offset=excluded.offset,t=excluded.t',
                   (identity, offset, now))
        backlog |= offset < stat.st_size
    return {'available': log.is_file(), 'processed': processed, 'malformed': malformed, 'backlog': backlog,
            'gateway_ingress_configured': bool(ingress)}

def http_stats():
    return {'external_requests': 0, 'public_requests': 0, 'gateway_requests': 0, 'local_requests': 0, 'unknown_requests': 0, 'received': 0, 'sent': 0,
            'errors4': 0, 'errors5': 0, 'duration': 0, 'average_ms': None}

def add_http(stats, row):
    if row['scope'] in ('external', 'gateway'):
        stats['external_requests'] += row['hits']
        stats['public_requests' if row['scope'] == 'external' else 'gateway_requests'] += row['hits']
    else:
        stats[row['scope'] + '_requests'] += row['hits']
    if row['scope'] in ('external', 'gateway'):
        for key in ('received', 'sent', 'errors4', 'errors5', 'duration'):
            stats[key] += row[key]

def finish_http(stats):
    if stats['external_requests']:
        stats['average_ms'] = round(stats['duration'] * 1000 / stats['external_requests'], 1)
    stats.pop('duration')
    return stats

def generate_report(db, items, domains, now, errors):
    earliest = db.execute('SELECT min(t) FROM resource').fetchone()[0]
    report = {'version': 1, 'generated_at': int(now * 1000), 'started_at': metadata(db, 'started_at', now) * 1000,
              'source': 'Caddy configuration and local Incus', 'errors': errors,
              'access': metadata(db, 'access', {}), 'routes_updated_at': metadata(db, 'routes_updated_at', 0) * 1000,
              'domains': domains, 'instances': {}, 'windows': {}}
    disks = {row['key']: dict(row) for row in db.execute('SELECT * FROM disk')}
    for item in items:
        config = item.get('expanded_config') or {}
        roots = [d for d in (item.get('expanded_devices') or {}).values() if d.get('type') == 'disk' and d.get('path') == '/']
        report['instances'][item['_key']] = {'name': item['name'], 'project': item['_project'],
            'status': item.get('status'), 'disk': disks.get(item['_key']),
            'specs': {'cpu': config.get('limits.cpu'), 'memory': config.get('limits.memory'),
                      'disk': roots[0].get('size') if roots else None}, 'windows': {}}
    resources = list(db.execute('SELECT * FROM resource WHERE t>=? ORDER BY t', (now - 86400 - 90,)))
    requests = list(db.execute('SELECT * FROM http WHERE minute>=? ORDER BY minute', (now - 86400 - 60,)))
    for domain in domains:
        domain['windows'] = {}
    for seconds in WINDOWS:
        start = now - seconds
        # HTTP request totals have minute resolution; expose their actual start.
        minute_start = int(start // 60) * 60
        window = {'seconds': seconds, 'coverage_seconds': round(max(0, now - max(start, earliest or now))),
                  'http_start': minute_start * 1000, 'http': http_stats(),
                  'network': {'received': 0, 'sent': 0}, 'chart': [[0, 0, 0, 0, 0] for _ in range(36)]}
        instance_stats = {key: {'received': 0, 'sent': 0, 'cpu_sum': 0, 'cpu_time': 0,
                               'percent_sum': 0, 'percent_time': 0, 'memory_sum': 0, 'memory_time': 0,
                               'memory_percent_sum': 0, 'memory_percent_time': 0,
                               'network_seconds': 0, 'http': http_stats(),
                               'chart': [[0, 0, 0, 0, 0] for _ in range(36)]} for key in report['instances']}
        domain_stats = {d['name']: http_stats() for d in domains}
        for row in resources:
            if row['t'] <= start or row['key'] not in instance_stats:
                continue
            stat = instance_stats[row['key']]
            dt = min(row['dt'], max(0, row['t'] - start))
            fraction = dt / row['dt'] if row['dt'] > 0 else 0
            if row['cpu'] is not None:
                stat['cpu_sum'] += row['cpu'] * dt
                stat['cpu_time'] += dt
                if row['capacity']:
                    stat['percent_sum'] += row['cpu'] / row['capacity'] * 100 * dt
                    stat['percent_time'] += dt
            if row['memory'] is not None:
                stat['memory_sum'] += row['memory'] * dt
                stat['memory_time'] += dt
            if row['memory'] is not None and row['memory_total']:
                stat['memory_percent_sum'] += row['memory'] / row['memory_total'] * 100 * dt
                stat['memory_percent_time'] += dt
            if row['rx'] is not None:
                stat['network_seconds'] += dt
                received, sent = row['rx'] * fraction, row['tx'] * fraction
                stat['received'] += received
                stat['sent'] += sent
                window['network']['received'] += received
                window['network']['sent'] += sent
                bucket = min(35, max(0, int((row['t'] - start) / seconds * 36)))
                window['chart'][bucket][0] += received
                window['chart'][bucket][1] += sent
                stat['chart'][bucket][0] += received
                stat['chart'][bucket][1] += sent
        for row in requests:
            if row['minute'] < minute_start:
                continue
            add_http(window['http'], row)
            name = row['host'] if row['host'] in domain_stats else next((d['name'] for d in domains
                      if '*' in d['name'] and fnmatch.fnmatchcase(row['host'], d['name'])), None)
            if name:
                add_http(domain_stats[name], row)
            if row['owner'] in instance_stats:
                add_http(instance_stats[row['owner']]['http'], row)
            if row['scope'] in ('external', 'gateway'):
                bucket = min(35, max(0, int((row['minute'] - start) / seconds * 36)))
                window['chart'][bucket][2] += row['hits']
                window['chart'][bucket][3] += row['received']
                window['chart'][bucket][4] += row['sent']
                if row['owner'] in instance_stats:
                    chart = instance_stats[row['owner']]['chart'][bucket]
                    chart[2] += row['hits']
                    chart[3] += row['received']
                    chart[4] += row['sent']
        window['http'] = finish_http(window['http'])
        for key, stat in instance_stats.items():
            result = {name: round(stat[name]) for name in ('received', 'sent', 'network_seconds')}
            for name, total, span in (('cpu_cores', 'cpu_sum', 'cpu_time'), ('cpu_percent', 'percent_sum', 'percent_time'),
                                     ('memory_bytes', 'memory_sum', 'memory_time'), ('memory_percent', 'memory_percent_sum', 'memory_percent_time')):
                result[name] = round(stat[total] / stat[span], 2) if stat[span] else None
            result['http'] = finish_http(stat['http'])
            result['chart'] = stat['chart']
            report['instances'][key]['windows'][str(seconds)] = result
        for domain in domains:
            domain['windows'][str(seconds)] = finish_http(domain_stats[domain['name']])
        report['windows'][str(seconds)] = window
    return report

def publish(report):
    REPORT.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(mode='w', dir=REPORT.parent, delete=False) as output:
        json.dump(report, output, separators=(',', ':'), allow_nan=False)
        output.write('\n')
        os.fchmod(output.fileno(), 0o644)
        staged = output.name
    os.replace(staged, REPORT)

def collect(db, config):
    now = time.time()
    errors = []
    items = incus_inventory(config)
    domains = metadata(db, 'domains', [])
    caddy_path = Path(config.get('caddy_config', '/etc/caddy/Caddyfile'))
    config_mtime = caddy_path.stat().st_mtime if caddy_path.exists() else 0
    signature = [[i['_key'], sorted(addresses(i)), sorted((d.get('listen', ''), d.get('connect', ''))
                 for d in (i.get('expanded_devices') or {}).values() if d.get('type') == 'proxy')] for i in items]
    if (metadata(db, 'route_version') != ROUTE_VERSION or now - metadata(db, 'routes_updated_at', 0) >= 300 or not domains
            or signature != metadata(db, 'inventory_signature') or config_mtime != metadata(db, 'config_mtime')):
        try:
            domains, enabled = route_inventory(config, items)
            save_metadata(db, 'domains', domains)
            save_metadata(db, 'route_version', ROUTE_VERSION)
            save_metadata(db, 'routes_updated_at', now)
            save_metadata(db, 'logging_enabled', enabled)
            save_metadata(db, 'inventory_signature', signature)
            save_metadata(db, 'config_mtime', config_mtime)
        except (RuntimeError, OSError, ValueError, subprocess.TimeoutExpired):
            errors.append('Caddy route discovery unavailable; previous routes retained.')
    sample_resources(db, items, now)
    access = collect_access(db, config, domains, now)
    access['configured'] = metadata(db, 'logging_enabled', False)
    previous = metadata(db, 'access', {})
    access['since'] = previous.get('since') or (now * 1000 if access['available'] else None)
    access['malformed_total'] = previous.get('malformed_total', 0) + access['malformed']
    save_metadata(db, 'access', access)
    db.execute('DELETE FROM resource WHERE t<?', (now - 86400 - 90,))
    db.execute('DELETE FROM http WHERE minute<?', (now - 86400 - 60,))
    db.execute('DELETE FROM cursor WHERE t<?', (now - 3 * 86400,))
    if metadata(db, 'started_at') is None:
        save_metadata(db, 'started_at', now)
    db.commit()  # Counters and log offsets commit together before publishing.
    publish(generate_report(db, items, domains, now, errors))
    print(f'Collected {len(items)} instances and {len(domains)} domains; {access["processed"]} completed requests.')

def disk_usage(item):
    now = time.time()
    try:
        text = command(['incus', '--force-local', '--project', item['_project'], 'exec', item['name'], '--',
                        'timeout', '-k', '3', '20', 'du', '-sx', '-B1', '/'], timeout=25)
        return item['_key'], now, int(text.split()[0]), None
    except (RuntimeError, OSError, ValueError, subprocess.TimeoutExpired):
        return item['_key'], now, None, 'Unavailable'

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('operation', choices=('collect', 'disks'))
    args = parser.parse_args()
    config = json.loads(CONFIG.read_text()) if CONFIG.exists() else {}
    STATE.mkdir(mode=0o700, parents=True, exist_ok=True)
    os.umask(0o077)
    with (STATE / (args.operation + '.lock')).open('w') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return
        with closing(sqlite3.connect(STATE / 'metrics.sqlite', timeout=10)) as db:
            db.row_factory = sqlite3.Row
            db.execute('PRAGMA journal_mode=WAL')
            db.executescript(SCHEMA)
            if args.operation == 'collect':
                collect(db, config)
            else:
                items = [i for i in incus_inventory(config) if i.get('status', '').lower() == 'running']
                with ThreadPoolExecutor(max_workers=2) as pool:
                    for result in pool.map(disk_usage, items):
                        db.execute('INSERT OR REPLACE INTO disk VALUES(?,?,?,?)', result)
                        db.commit()
                print(f'Sampled root-file usage for {len(items)} running instances.')

if __name__ == '__main__':
    main()
