#!/bin/sh
# Mask the first administrator password on the VM and stream it over stdin; it
# never appears in argv, the environment, shell history, or process listings.
set -eu

if [ "$#" -lt 1 ] || [ "$#" -gt 2 ]; then
  echo "usage: $0 <email> [display-name]" >&2
  exit 2
fi
if [ ! -t 0 ] || [ ! -t 1 ]; then
  echo "run this script from an interactive SSH terminal" >&2
  exit 1
fi

EMAIL=$1
DISPLAY_NAME=${2:-Baris Kose}
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
COMPOSE="$ROOT/infrastructure/oracle/compose.sh"

restore_tty() {
  stty echo 2>/dev/null || true
  unset password
}
trap restore_tty EXIT HUP INT TERM

printf 'Administrator password: '
stty -echo
IFS= read -r password
stty echo
printf '\n'
trap - EXIT HUP INT TERM

if [ -z "$password" ]; then
  echo "password cannot be empty" >&2
  exit 1
fi

printf '%s\n' "$password" | "$COMPOSE" exec -T api \
  node dist/scripts/create-researcher.js \
  --email "$EMAIL" --name "$DISPLAY_NAME" --admin
unset password
