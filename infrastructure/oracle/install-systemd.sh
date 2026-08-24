#!/bin/sh
# Install user-level timers without giving a root service execution rights over
# a user-owned Git checkout. Lingering is mandatory so these timers survive
# logout and reboot.
set -eu
umask 077

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
SOURCE_DIR="$ROOT/infrastructure/oracle/systemd"
UNIT_DIR=${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user

case "$ROOT" in
  *[!A-Za-z0-9_./-]*)
    echo "repository path contains unsupported characters: $ROOT" >&2
    exit 1
    ;;
esac

if ! command -v systemctl >/dev/null 2>&1; then
  echo "systemd is required to install the operations timers" >&2
  exit 1
fi
if ! command -v loginctl >/dev/null 2>&1; then
  echo "systemd-logind is required to verify persistent user timers" >&2
  exit 1
fi
linger=$(loginctl show-user "$(id -u)" --property=Linger --value 2>/dev/null) || {
  echo "cannot verify systemd lingering for the deployment user" >&2
  exit 1
}
if [ "$linger" != "yes" ]; then
  echo "user lingering is disabled; run: sudo loginctl enable-linger $(id -un)" >&2
  exit 1
fi

mkdir -p "$UNIT_DIR"
temporary=$(mktemp "${TMPDIR:-/tmp}/lpr-systemd.XXXXXX")
trap 'rm -f "$temporary"' EXIT HUP INT TERM

for unit in lpr-health-recovery.service lpr-backup.service lpr-restic-check.service; do
  sed "s|@ROOT@|$ROOT|g" "$SOURCE_DIR/$unit.in" >"$temporary"
  install -m 0644 "$temporary" "$UNIT_DIR/$unit"
done
for unit in lpr-health-recovery.timer lpr-backup.timer lpr-restic-check.timer; do
  install -m 0644 "$SOURCE_DIR/$unit" "$UNIT_DIR/$unit"
done

systemctl --user daemon-reload
systemctl --user enable --now lpr-health-recovery.timer lpr-backup.timer lpr-restic-check.timer
systemctl --user list-timers lpr-health-recovery.timer lpr-backup.timer lpr-restic-check.timer

echo "installed user-level health recovery, backup and Restic check timers"
echo "verified systemd user lingering; timers persist across logout and reboot"
