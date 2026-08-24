#!/bin/sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
cd "$ROOT"

"$ROOT/infrastructure/oracle/backup.sh"
git pull --ff-only
if systemctl --user is-enabled --quiet lpr-health-recovery.timer 2>/dev/null; then
  "$ROOT/infrastructure/oracle/install-systemd.sh"
fi
exec "$ROOT/infrastructure/oracle/deploy.sh"
