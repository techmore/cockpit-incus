#!/usr/bin/env python3
"""Private collection; publish only bounded project-level aggregates to Cockpit."""
import fcntl
import json
import os
import sqlite3
import subprocess
import tempfile
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path
from urllib.request import urlopen

CONFIG = Path('/etc/cockpit-incus/projects.json')
REPORT = Path('/var/cache/cockpit-incus/projects.json')
WINDOWS = (300, 900, 1200, 3600, 14400, 28800, 86400)


def stamp(value):
    return datetime.fromtimestamp(value, timezone.utc).strftime('%Y-%m-%d %H:%M:%S')


def guest(app, args):
    command = ['incus', '--force-local', '--project', app.get('incus_project', 'default'), 'exec', app['instance'], '--', *args]
    result = subprocess.run(command, capture_output=True, text=True, timeout=10, check=True)
    return result.stdout


def operation(app):
    result = {'health': {'status': 'unavailable'}, 'deployment': None, 'activity': None}
    began = time.monotonic()
    try:
        with urlopen(app['health_url'], timeout=5) as response:
            body = response.read(65536)
            payload = json.loads(body) if 'json' in response.headers.get('Content-Type', '') else {}
            result['health'] = {'status': 'healthy' if response.status == 200 else 'unhealthy',
                                'latency_ms': round((time.monotonic() - began) * 1000, 1)}
            if app.get('adapter') == 'sonder':
                result['deployment'] = {'version': payload.get('version'), 'commit': payload.get('build')}
    except Exception:
        result['health'] = {'status': 'unhealthy', 'message': 'Health endpoint unavailable'}
    try:
        if app.get('adapter') == 'swartzit':
            receipt = json.loads(guest(app, ['cat', '/var/lib/swartzit/state/current-release.json']))
            result['deployment'] = {k: receipt.get(k) for k in ('version', 'commit', 'installed_at')}
            code = """import json,sqlite3
db=sqlite3.connect('file:/var/lib/swartzit/state/swartzit.sqlite?mode=ro',uri=True)
print(json.dumps({'runners_enabled':db.execute("SELECT count(*) FROM content_runners WHERE enabled=1 AND state<>'archived'").fetchone()[0], 'runners_paused':db.execute("SELECT count(*) FROM content_runners WHERE state='paused'").fetchone()[0], 'runner_failures_24h':db.execute("SELECT count(*) FROM content_runner_runs WHERE status IN ('failed','timeout') AND julianday(started_at)>=julianday('now','-1 day')").fetchone()[0], 'crawler_failures_24h':db.execute("SELECT count(*) FROM crawler_runs WHERE status='failed' AND julianday(started_at)>=julianday('now','-1 day')").fetchone()[0]}))"""
            result['activity'] = json.loads(guest(app, ['python3', '-c', code]))
        if app.get('adapter') == 'sonder':
            # API health JSON may omit build; the installed CLI provides its stamped revision.
            data = json.loads(guest(app, ['/usr/local/bin/sonder', 'app', 'status', '--json', '--config', '/etc/sonder/server.json']))
            result['deployment'] = {'version': data.get('version'), 'commit': data.get('build'),
                                    'installed_at': (data.get('status', {}).get('state') or {}).get('processStartTime')}
    except Exception:
        result['details_unavailable'] = True
    return result


def analytics(db, vhosts, now):
    placeholders = ','.join('?' for _ in vhosts)
    sites = [row[0] for row in db.execute(f'SELECT site_id FROM sites WHERE cname IN ({placeholders}) AND state=\'a\'', vhosts)]
    if not sites:
        return {'available': False, 'reason': 'Analytics site is not configured', 'windows': {}}
    marks = ','.join('?' for _ in sites)
    base = f'FROM hits h JOIN paths p ON p.path_id=h.path_id WHERE h.site_id IN ({marks}) AND h.created_at>=? AND h.created_at<?'
    first = db.execute(f'SELECT min(created_at) FROM hits WHERE site_id IN ({marks})', sites).fetchone()[0]
    result = {'available': True, 'provider': 'GoatCounter 2.7', 'first_observed_at': first, 'windows': {}}
    for seconds in WINDOWS:
        start = now - seconds
        args = [*sites, stamp(start), stamp(now)]
        counts = db.execute('SELECT count(*),count(DISTINCT CASE WHEN p.event=0 THEN h.session END),sum(p.event=1) ' + base, args).fetchone()
        events = counts[2] or 0
        window = {'pageviews': counts[0] - events, 'visits': counts[1], 'events': events}
        for name, extra, field in (
            ('pages', '', 'p.path'),
            ('events_top', '', 'p.path'),
            ('referrers', ' JOIN refs r ON r.ref_id=h.ref_id ', "CASE WHEN r.ref='' THEN 'Direct / internal' ELSE r.ref END"),
            ('browsers', ' JOIN browsers b ON b.browser_id=h.browser_id ', "COALESCE(b.name,'Unknown')"),
            ('systems', ' JOIN systems s ON s.system_id=h.system_id ', "COALESCE(s.name,'Unknown')")):
            querybase = base.replace(' WHERE ', extra + ' WHERE ', 1)
            kind = 1 if name == 'events_top' else 0
            rows = db.execute(f'SELECT {field} AS label,count(*) AS count {querybase} AND p.event=? GROUP BY label ORDER BY count DESC,label LIMIT 8', [*args, kind])
            window[name] = [{'label': row[0], 'count': row[1]} for row in rows]
        window['chart'] = [0] * 36
        for row in db.execute('SELECT h.created_at,count(*) ' + base + ' AND p.event=0 GROUP BY h.created_at', args):
            when = datetime.fromisoformat(row[0].replace('Z', '+00:00')).replace(tzinfo=timezone.utc).timestamp()
            bucket = min(35, max(0, int((when - start) / seconds * 36)))
            window['chart'][bucket] += row[1]
        result['windows'][str(seconds)] = window
    return result


def publish(report):
    REPORT.parent.mkdir(mode=0o755, parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile('w', dir=REPORT.parent, delete=False) as output:
        json.dump(report, output, allow_nan=False, separators=(',', ':'))
        output.write('\n')
        os.fchmod(output.fileno(), 0o644)
        staged = output.name
    os.replace(staged, REPORT)


def discover(apps):
    """Add routed applications without inventing analytics or release metadata."""
    try:
        telemetry = json.loads(Path('/var/cache/cockpit-incus/telemetry.json').read_text())
    except (OSError, ValueError):
        return apps
    known = {(app.get('incus_project', 'default'), app.get('instance')) for app in apps}
    domains = {}
    for route in telemetry.get('domains', []):
        if len(route.get('instances', [])) == 1 and route.get('url'):
            domains.setdefault(route['instances'][0], []).append(route)
    for key, routes in sorted(domains.items()):
        project, instance = key.split('/', 1)
        if (project, instance) in known:
            continue
        primary = sorted(routes, key=lambda row: (bool(row.get('redirects')), len(row['name'])))[0]
        apps.append({'id': key.replace('/', '-'), 'name': instance.replace('-', ' ').title(),
                     'description': 'Discovered from Caddy', 'instance': instance, 'incus_project': project,
                     'domains': sorted({route['name'] for route in routes}), 'site_url': primary['url'],
                     'health_url': primary['url'], 'color': '#65758b'})
    return apps[:30]


def main():
    os.umask(0o077)
    lock_path = Path('/var/lib/cockpit-incus/projects.lock')
    lock_path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    with lock_path.open('w') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return
        config = json.loads(CONFIG.read_text()) if CONFIG.exists() else {'applications': []}
        apps = discover(config.get('applications', [])[:30]) if config.get('discover_routes', True) else config.get('applications', [])[:30]
        now = time.time()
        report = {'version': 1, 'generated_at': int(now * 1000), 'projects': []}
        report['analytics_services'] = {name: subprocess.run(['systemctl', 'is-active', '--quiet', name], timeout=3).returncode == 0
            for name in ('project-analytics-goatcounter.service', 'project-analytics-ingest.service')}
        try:
            report['analytics_backup'] = json.loads(Path('/var/lib/cockpit-incus/projects-backup.json').read_text())
        except (OSError, ValueError):
            report['analytics_backup'] = None
        with ThreadPoolExecutor(max_workers=3) as pool:
            operations = list(pool.map(operation, apps))
        db = None
        try:
            db = sqlite3.connect('file:' + config.get('analytics_db', '/var/lib/project-analytics/goatcounter.sqlite3') + '?mode=ro', uri=True, timeout=2)
            db.execute('PRAGMA query_only=ON')
        except sqlite3.Error:
            pass
        try:
            for app, status in zip(apps, operations):
                entry = {key: app.get(key) for key in ('id', 'name', 'description', 'instance', 'incus_project', 'domains', 'site_url', 'admin_url', 'github_url', 'color')}
                entry.update(status)
                try:
                    entry['analytics'] = analytics(db, app.get('analytics_vhosts', []), now) if db and app.get('analytics_vhosts') else {'available': False, 'windows': {}}
                except (sqlite3.Error, ValueError, TypeError):
                    entry['analytics'] = {'available': False, 'reason': 'Analytics collection unavailable', 'windows': {}}
                report['projects'].append(entry)
        finally:
            if db:
                db.close()
        publish(report)
        print(f'Updated {len(apps)} project summaries')


if __name__ == '__main__':
    main()
