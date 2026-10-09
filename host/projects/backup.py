#!/usr/bin/env python3
"""Daily SQLite online backup with a small private retention set."""
import json
import os
import sqlite3
import tempfile
import time
from datetime import datetime, timezone
from pathlib import Path

os.umask(0o077)
directory = Path('/var/backups/project-analytics')
directory.mkdir(mode=0o700,parents=True,exist_ok=True)
stamp = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')
with tempfile.NamedTemporaryFile(dir=directory,prefix='.incoming-',delete=False) as temp:
    staged = Path(temp.name)
try:
    source = sqlite3.connect('file:/var/lib/project-analytics/goatcounter.sqlite3?mode=ro',uri=True)
    target = sqlite3.connect(staged)
    source.backup(target)
    result = target.execute('PRAGMA integrity_check').fetchone()[0]
    target.close(); source.close()
    if result != 'ok':
        raise RuntimeError('Analytics backup integrity check failed')
    staged.replace(directory / ('analytics-' + stamp + '.sqlite3'))
    for old in sorted(directory.glob('analytics-*.sqlite3'))[:-7]:
        old.unlink()
    receipt = Path('/var/lib/cockpit-incus/projects-backup.json')
    receipt.write_text(json.dumps({'status':'success','at':int(time.time()*1000),'retained':len(list(directory.glob('analytics-*.sqlite3')))})+'\n')
    print('Private analytics backup completed')
finally:
    staged.unlink(missing_ok=True)
