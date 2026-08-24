#!/bin/sh
# Generates all production secrets on the VM without printing them. Refuses to
# overwrite an existing file so VAPID keys cannot rotate during a redeploy.
set -eu
umask 077

if [ "$#" -ne 1 ]; then
  echo "usage: $0 <public-ipv4>" >&2
  exit 2
fi

PUBLIC_IP=$1
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
TEMPLATE="$ROOT/infrastructure/oracle/.env.production.example"
TARGET="$ROOT/.env.production"

if [ -e "$TARGET" ]; then
  echo "$TARGET already exists; refusing to rotate production secrets" >&2
  exit 1
fi

session_secret=$(openssl rand -hex 48)
postgres_password=$(openssl rand -hex 32)
app_password=$(openssl rand -hex 32)
vapid_json=$(docker run --rm node:22-alpine \
  npx --yes web-push@3.6.7 generate-vapid-keys --json)

PUBLIC_IP=$PUBLIC_IP \
SESSION_SECRET=$session_secret \
POSTGRES_PASSWORD=$postgres_password \
APP_DATABASE_PASSWORD=$app_password \
VAPID_JSON=$vapid_json \
TEMPLATE=$TEMPLATE \
TARGET=$TARGET \
python3 - <<'PY'
import ipaddress
import json
import os
import tempfile
from pathlib import Path

public_ip = str(ipaddress.IPv4Address(os.environ["PUBLIC_IP"]))
vapid = json.loads(os.environ["VAPID_JSON"])
participant = f"participant.{public_ip}.sslip.io"

replacements = {
    "POSTGRES_PASSWORD": os.environ["POSTGRES_PASSWORD"],
    "APP_DATABASE_PASSWORD": os.environ["APP_DATABASE_PASSWORD"],
    "API_HOST": f"api.{public_ip}.sslip.io",
    "PARTICIPANT_HOST": participant,
    "RESEARCHER_HOST": f"researcher.{public_ip}.sslip.io",
    "SESSION_SECRET": os.environ["SESSION_SECRET"],
    "VAPID_PUBLIC_KEY": vapid["publicKey"],
    "VAPID_PRIVATE_KEY": vapid["privateKey"],
    "VAPID_SUBJECT": f"https://{participant}",
}

source = Path(os.environ["TEMPLATE"]).read_text()
lines = []
for line in source.splitlines():
    key = line.split("=", 1)[0] if "=" in line else None
    lines.append(f"{key}={replacements[key]}" if key in replacements else line)

target = Path(os.environ["TARGET"])
fd, temporary_name = tempfile.mkstemp(prefix=f".{target.name}.", dir=target.parent)
temporary = Path(temporary_name)
try:
    with os.fdopen(fd, "w") as handle:
        handle.write("\n".join(lines) + "\n")
        handle.flush()
        os.fsync(handle.fileno())
    temporary.chmod(0o600)
    temporary.replace(target)
except BaseException:
    temporary.unlink(missing_ok=True)
    raise
PY

unset session_secret postgres_password app_password vapid_json
echo "created $TARGET with stable VAPID and generated secrets (mode 600)"
