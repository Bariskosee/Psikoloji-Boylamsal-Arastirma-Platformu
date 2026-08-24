#!/bin/sh
# Nightly backup for the self-hosted deployment (NFR-18, ADR-012).
#
# ── Why this script exists ──────────────────────────────────────────────────
# A managed provider gives you point-in-time recovery. Self-hosting does not,
# and NFR-18 is explicit that an untested backup is not a backup. This is the
# minimum that makes the requirement honest on one VM: a nightly logical dump,
# kept for a fortnight, restorable by `docs/runbooks/restore-drill.md`.
#
# It is NOT point-in-time recovery. Between two runs of this script there is up
# to 24 hours of responses that a restore would lose. If the study's ethics
# approval requires tighter recovery, that needs WAL archiving to off-site
# storage — see the runbook's §6.
#
# ── The line that the restore drill found ───────────────────────────────────
# `pg_dumpall --roles-only` is not optional. `pg_dump` of a single database
# does NOT include roles, so restoring it alone silently loses `app_analytics`
# and the whole NFR-03 boundary — while every row arrives intact and a
# row-count check passes. That finding is recorded in restore-drill.md §5.1.
#
# Install (from the repository root, as the VM's own user):
#   crontab -e
#   17 3 * * * cd /opt/lpr && sh infrastructure/compose/backup.sh >> /var/log/lpr-backup.log 2>&1
set -eu

COMPOSE="${COMPOSE:-docker compose -f infrastructure/compose/docker-compose.yml --env-file .env.production}"
OUT="${BACKUP_DIR:-infrastructure/compose/backups}"
KEEP_DAYS="${BACKUP_KEEP_DAYS:-14}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"

mkdir -p "$OUT"

# Roles first: a restore applies them before the data, and a dump taken in the
# other order is a dump that restores into a broken privilege boundary.
$COMPOSE exec -T postgres sh -c 'pg_dumpall -U "$POSTGRES_USER" --roles-only' > "$OUT/roles-$STAMP.sql"
$COMPOSE exec -T postgres sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' > "$OUT/lpr-$STAMP.dump"

# Fail loudly on an empty dump rather than rotating a good backup away in
# favour of a zero-byte file — the classic way a backup regime quietly dies.
if [ ! -s "$OUT/lpr-$STAMP.dump" ]; then
  echo "BACKUP FAILED: $OUT/lpr-$STAMP.dump is empty" >&2
  rm -f "$OUT/lpr-$STAMP.dump" "$OUT/roles-$STAMP.sql"
  exit 1
fi

find "$OUT" -name 'lpr-*.dump' -mtime "+$KEEP_DAYS" -delete
find "$OUT" -name 'roles-*.sql' -mtime "+$KEEP_DAYS" -delete

echo "backup ok: $STAMP ($(du -h "$OUT/lpr-$STAMP.dump" | cut -f1))"

# ── The half nobody does ────────────────────────────────────────────────────
# A backup on the same disk as the database is not a backup: it survives a
# dropped table and not a lost volume, a deleted instance, or a compromised
# host. Copy it off this machine. `rclone`, `rsync` to a second box, or object
# storage — the mechanism matters less than the copy existing somewhere else.
#
#   rclone copy "$OUT" remote:lpr-backups --max-age 25h
