#!/usr/bin/env python3
"""Provision pinned GoatCounter sites and count-only credentials privately."""
import json
import os
import pwd
import re
import secrets
import sqlite3
import subprocess
from pathlib import Path

DB = Path('/var/lib/project-analytics/goatcounter.sqlite3')
CONFIG = Path('/etc/cockpit-incus/projects.json')


def command(args, password=None):
    result = subprocess.run(['runuser', '-u', 'project-analytics', '--', '/usr/local/bin/goatcounter', 'db', *args, '-db', 'sqlite+' + str(DB)],
        input=password, text=True, capture_output=True)
    if result.returncode:
        raise RuntimeError('GoatCounter provisioning failed: ' + result.stderr[-400:])


def main():
    os.umask(0o077)
    apps = json.loads(CONFIG.read_text()).get('applications', [])
    ingest = {'sites': {}}
    if not DB.exists():
        command(['newdb'])
    db = sqlite3.connect(DB)
    for app in apps:
        if not re.fullmatch(r'[a-z][a-z0-9-]{1,49}', app['id']):
            raise ValueError('Application id must be lowercase letters/digits/dashes')
        hosts = app.get('analytics_vhosts', [])
        if not hosts:
            continue
        if len(hosts) != 1:
            raise ValueError('Use one canonical analytics vhost per application')
        vhost = hosts[0]
        if not re.fullmatch(r'[a-z0-9.-]{4,100}', vhost):
            raise ValueError('Invalid analytics vhost')
        site = db.execute('SELECT site_id FROM sites WHERE cname=?', (vhost,)).fetchone()
        email = app['id'] + '@projects.invalid'
        if not site:
            password = secrets.token_urlsafe(32)
            command(['create', 'site', '-vhost', vhost, '-user.email', email, '-user.password', '-'], password)
            private = Path('/etc/project-analytics/' + app['id'] + '-admin.json')
            private.write_text(json.dumps({'email':email,'password':password,'vhost':vhost}) + '\n')
            private.chmod(0o600)
            site = db.execute('SELECT site_id FROM sites WHERE cname=?', (vhost,)).fetchone()
        site_id = site[0]
        settings = json.loads(db.execute('SELECT settings FROM sites WHERE site_id=?',(site_id,)).fetchone()[0])
        settings['data_retention'] = 31
        settings['public'] = 'private'
        db.execute('UPDATE sites SET settings=? WHERE site_id=?',(json.dumps(settings),site_id))
        db.commit()
        token = db.execute("SELECT token FROM api_tokens WHERE site_id=? AND name='cockpit-project-ingest'", (site_id,)).fetchone()
        if not token:
            command(['create','apitoken','-user',email,'-name','cockpit-project-ingest','-perm','count'])
            token = db.execute("SELECT token FROM api_tokens WHERE site_id=? AND name='cockpit-project-ingest'",(site_id,)).fetchone()
        for authority in app.get('tracking_hosts', app.get('domains', [])):
            if not re.fullmatch(r'[a-z0-9.-]+(?::[0-9]{1,5})?', authority):
                raise ValueError('Invalid tracking host')
            ingest['sites'][authority] = {'vhost':vhost,'token':token[0]}
    db.close()
    owner = pwd.getpwnam('project-analytics')
    # CLI-created files stay service-owned; the collector only opens read-only.
    for entry in DB.parent.iterdir():
        if entry.is_file():
            os.chown(entry,owner.pw_uid,owner.pw_gid)
    path = Path('/etc/project-analytics/ingest.json')
    path.write_text(json.dumps(ingest) + '\n')
    path.chmod(0o640)
    os.chown(path,0,owner.pw_gid)
    print(f'Provisioned {len(ingest["sites"])} tracking hosts; credentials stay private')


if __name__ == '__main__':
    main()
