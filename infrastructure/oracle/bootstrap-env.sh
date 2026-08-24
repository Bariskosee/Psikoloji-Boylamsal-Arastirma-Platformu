#!/bin/sh
# Generates production secrets on the VM without printing them. Real participant
# deployments require stable origins. Ephemeral-IP sslip.io names are available
# only through the explicitly unsafe smoke-test mode.
set -eu
umask 077

usage() {
  cat >&2 <<EOF
usage:
  $0 --domain <base-domain> --acme-email <email>
  $0 --hostnames <api-host> <participant-host> <researcher-host> --acme-email <email>
  $0 --reserved-ip <public-ipv4> --acme-email <email>
  $0 --smoke-test-ip <ephemeral-public-ipv4> --acme-email <email>

--domain and --hostnames keep participant origins stable when DNS targets change.
--reserved-ip is an assertion that the supplied public IP is reserved and stable.
--smoke-test-ip is for smoke tests only; never enroll real participants with it.
EOF
  exit 2
}

[ "$#" -gt 0 ] || usage

DEPLOYMENT_MODE=
ORIGIN_MODE=
ORIGIN_VALUE=
API_HOST_INPUT=
PARTICIPANT_HOST_INPUT=
RESEARCHER_HOST_INPUT=
ACME_EMAIL=

case "$1" in
  --domain)
    [ "$#" -eq 4 ] || usage
    [ "$3" = "--acme-email" ] || usage
    DEPLOYMENT_MODE=participant
    ORIGIN_MODE=domain
    ORIGIN_VALUE=$2
    ACME_EMAIL=$4
    ;;
  --hostnames)
    [ "$#" -eq 6 ] || usage
    [ "$5" = "--acme-email" ] || usage
    DEPLOYMENT_MODE=participant
    ORIGIN_MODE=domain
    API_HOST_INPUT=$2
    PARTICIPANT_HOST_INPUT=$3
    RESEARCHER_HOST_INPUT=$4
    ACME_EMAIL=$6
    ;;
  --reserved-ip)
    [ "$#" -eq 4 ] || usage
    [ "$3" = "--acme-email" ] || usage
    DEPLOYMENT_MODE=participant
    ORIGIN_MODE=reserved-ip
    ORIGIN_VALUE=$2
    ACME_EMAIL=$4
    ;;
  --smoke-test-ip)
    [ "$#" -eq 4 ] || usage
    [ "$3" = "--acme-email" ] || usage
    DEPLOYMENT_MODE=smoke
    ORIGIN_MODE=ephemeral-ip
    ORIGIN_VALUE=$2
    ACME_EMAIL=$4
    ;;
  *)
    usage
    ;;
esac

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
TEMPLATE="$ROOT/infrastructure/oracle/.env.production.example"
TARGET="$ROOT/.env.production"

if [ -e "$TARGET" ]; then
  echo "$TARGET already exists; refusing to rotate production secrets" >&2
  exit 1
fi

DEPLOYMENT_MODE=$DEPLOYMENT_MODE \
ORIGIN_MODE=$ORIGIN_MODE \
ORIGIN_VALUE=$ORIGIN_VALUE \
API_HOST_INPUT=$API_HOST_INPUT \
PARTICIPANT_HOST_INPUT=$PARTICIPANT_HOST_INPUT \
RESEARCHER_HOST_INPUT=$RESEARCHER_HOST_INPUT \
ACME_EMAIL=$ACME_EMAIL \
TEMPLATE=$TEMPLATE \
TARGET=$TARGET \
python3 - <<'PY'
import ipaddress
import json
import os
import re
import subprocess
import sys
import tempfile
from pathlib import Path


class InputError(ValueError):
    pass


def hostname(value: str, field: str) -> str:
    normalized = value.lower()
    if value != value.strip() or value.endswith("."):
        raise InputError(f"{field} must not contain surrounding whitespace or a trailing dot")
    if "://" in value or any(character in value for character in "/?#:"):
        raise InputError(f"{field} must be a hostname without a scheme, port, path, query, or fragment")
    if len(normalized) > 253 or "." not in normalized:
        raise InputError(f"{field} must be a public fully-qualified hostname")
    labels = normalized.split(".")
    if any(
        not label
        or len(label) > 63
        or re.fullmatch(r"[a-z0-9](?:[a-z0-9-]*[a-z0-9])?", label) is None
        for label in labels
    ):
        raise InputError(f"{field} is not a valid hostname")
    return normalized


def stable_hostname(value: str, field: str) -> str:
    normalized = hostname(value, field)
    if normalized == "sslip.io" or normalized.endswith(".sslip.io"):
        raise InputError(
            f"{field} uses sslip.io; use --reserved-ip for a reserved address "
            "or --smoke-test-ip for an ephemeral address"
        )
    return normalized


def public_ipv4(value: str) -> str:
    try:
        address = ipaddress.IPv4Address(value)
    except ipaddress.AddressValueError as error:
        raise InputError("public-ipv4 must be a valid IPv4 address") from error
    if not address.is_global:
        raise InputError("public-ipv4 must be globally routable")
    return str(address)


def contact_email(value: str) -> str:
    if value != value.strip() or any(character.isspace() for character in value):
        raise InputError("ACME email must not contain whitespace")
    if len(value) > 254 or value.count("@") != 1:
        raise InputError("ACME email must be a valid email address")
    local, email_domain = value.rsplit("@", 1)
    if not local or len(local) > 64:
        raise InputError("ACME email must be a valid email address")
    return f"{local}@{hostname(email_domain, 'ACME email domain')}"


deployment_mode = os.environ["DEPLOYMENT_MODE"]
origin_mode = os.environ["ORIGIN_MODE"]

try:
    acme_email = contact_email(os.environ["ACME_EMAIL"])
    if origin_mode == "domain" and os.environ["ORIGIN_VALUE"]:
        base_domain = stable_hostname(os.environ["ORIGIN_VALUE"], "base-domain")
        api_host = stable_hostname(f"api.{base_domain}", "api-host")
        participant_host = stable_hostname(f"participant.{base_domain}", "participant-host")
        researcher_host = stable_hostname(f"researcher.{base_domain}", "researcher-host")
    elif origin_mode == "domain":
        api_host = stable_hostname(os.environ["API_HOST_INPUT"], "api-host")
        participant_host = stable_hostname(
            os.environ["PARTICIPANT_HOST_INPUT"], "participant-host"
        )
        researcher_host = stable_hostname(
            os.environ["RESEARCHER_HOST_INPUT"], "researcher-host"
        )
        if len({api_host, participant_host, researcher_host}) != 3:
            raise InputError("api, participant, and researcher hostnames must be distinct")
    elif origin_mode in {"reserved-ip", "ephemeral-ip"}:
        public_ip = public_ipv4(os.environ["ORIGIN_VALUE"])
        sslip_label = public_ip.replace(".", "-")
        api_host = f"api.{sslip_label}.sslip.io"
        participant_host = f"participant.{sslip_label}.sslip.io"
        researcher_host = f"researcher.{sslip_label}.sslip.io"
    else:
        raise InputError("unsupported origin mode")
except InputError as error:
    print(f"error: {error}", file=sys.stderr)
    raise SystemExit(2) from None

if deployment_mode == "smoke":
    print(
        "WARNING: SMOKE TEST ONLY. These sslip.io origins depend on an ephemeral "
        "public IP. DO NOT ENROLL REAL PARTICIPANTS: an IP change changes every "
        "origin and invalidates continuity cookies and push subscriptions.",
        file=sys.stderr,
    )
elif origin_mode == "reserved-ip":
    print(
        "IMPORTANT: --reserved-ip asserts that this address is reserved and stable. "
        "bootstrap-env.sh cannot verify the OCI reservation.",
        file=sys.stderr,
    )


def command_output(arguments: list[str]) -> str:
    completed = subprocess.run(
        arguments,
        check=True,
        stdout=subprocess.PIPE,
        text=True,
    )
    return completed.stdout.strip()


session_secret = command_output(["openssl", "rand", "-hex", "48"])
postgres_password = command_output(["openssl", "rand", "-hex", "32"])
app_password = command_output(["openssl", "rand", "-hex", "32"])
vapid = json.loads(
    command_output(
        [
            "docker",
            "run",
            "--rm",
            "node:22-alpine",
            "npx",
            "--yes",
            "web-push@3.6.7",
            "generate-vapid-keys",
            "--json",
        ]
    )
)
if not isinstance(vapid.get("publicKey"), str) or not isinstance(vapid.get("privateKey"), str):
    raise RuntimeError("web-push returned invalid VAPID key JSON")

replacements = {
    "DEPLOYMENT_MODE": deployment_mode,
    "ORIGIN_MODE": origin_mode,
    "POSTGRES_PASSWORD": postgres_password,
    "APP_DATABASE_PASSWORD": app_password,
    "API_HOST": api_host,
    "PARTICIPANT_HOST": participant_host,
    "RESEARCHER_HOST": researcher_host,
    "ACME_EMAIL": acme_email,
    "SESSION_SECRET": session_secret,
    "VAPID_PUBLIC_KEY": vapid["publicKey"],
    "VAPID_PRIVATE_KEY": vapid["privateKey"],
    "VAPID_SUBJECT": f"https://{participant_host}",
}

source = Path(os.environ["TEMPLATE"]).read_text()
lines = []
replaced = set()
for line in source.splitlines():
    key = line.split("=", 1)[0] if "=" in line else None
    if key in replacements:
        lines.append(f"{key}={replacements[key]}")
        replaced.add(key)
    else:
        lines.append(line)

missing = replacements.keys() - replaced
if missing:
    raise RuntimeError(f"template is missing required keys: {', '.join(sorted(missing))}")

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

if [ "$DEPLOYMENT_MODE" = "smoke" ]; then
  echo "created $TARGET in SMOKE TEST mode (mode 600); do not enroll real participants"
else
  echo "created $TARGET with participant-stable origins and secrets (mode 600)"
fi
