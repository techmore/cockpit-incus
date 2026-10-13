# Instance backups

`incus-backup.sh` exports every Incus instance (`incus export --instance-only`), checks the archive, keeps the newest
few per instance and records the time on the instance as `user.cockpit-incus.backup`. The dashboard's **Recovery**
column and **No recovery point** tile read that value.

```bash
install -Dm755 host/backup/incus-backup.sh ~/.local/bin/incus-backup.sh
install -Dm644 host/backup/incus-backup.service host/backup/incus-backup.timer -t ~/.config/systemd/user/
printf 'DEST=/path/on/another/drive\nKEEP=3\nMIN_FREE_GB=300\n' > ~/.config/cockpit-incus/backup.conf   # mkdir -p first
systemctl --user daemon-reload && systemctl --user enable --now incus-backup.timer
~/.local/bin/incus-backup.sh --dry-run
```

Put `DEST` on a different drive or machine than the Incus storage pool, otherwise a drive failure takes both.
Restoring: `incus import <archive>.tar.gz [new-name]`; it creates a stopped instance. Test a restore before you need one.
Running virtual machines and databases are exported crash-consistent only; dump databases separately.
