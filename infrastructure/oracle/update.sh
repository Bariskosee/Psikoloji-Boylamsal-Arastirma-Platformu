#!/bin/sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
cd "$ROOT"

"$ROOT/infrastructure/oracle/backup.sh"
git pull --ff-only
exec "$ROOT/infrastructure/oracle/deploy.sh"
