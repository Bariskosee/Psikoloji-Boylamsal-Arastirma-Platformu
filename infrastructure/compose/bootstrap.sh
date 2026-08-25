#!/usr/bin/env bash
# First-run bootstrap for the self-hosted deployment (ADR-012).
#
# ─────────────────────────────────────────────────────────────────────────────
# This exists for one reason: the deployment may have to be driven from a
# provider's VNC console, where copy-paste does not work and every character is
# typed by hand. Everything `self-hosted-deploy.md` §1.3 through §4 asks for is
# collapsed into one command that can be typed in a single line.
#
#   curl -fsSL <raw url to this file> | bash
#
# It is idempotent: re-running it will not regenerate secrets that already
# exist, because regenerating SESSION_SECRET signs every researcher out and
# regenerating the VAPID pair permanently kills every participant's push
# subscription (ADR-006, push-failure-triage.md §2).
#
# It does NOT replace the runbook. Read `docs/runbooks/self-hosted-deploy.md`
# before running this on a machine that will hold real participant data.
# ─────────────────────────────────────────────────────────────────────────────

set -euo pipefail

REPO="${LPR_REPO:-https://github.com/Bariskosee/Psikoloji-Boylamsal-Arastirma-Platformu.git}"
BRANCH="${LPR_BRANCH:-deploy/tuemcloud-vds}"
DIR="${LPR_DIR:-/opt/lpr}"
ENV_FILE="$DIR/.env.production"
COMPOSE="docker compose -f $DIR/infrastructure/compose/docker-compose.yml --env-file $ENV_FILE"

say() { printf '\n\033[1;34m==> %s\033[0m\n' "$*"; }
warn() { printf '\n\033[1;33m!!! %s\033[0m\n' "$*"; }

[ "$(id -u)" -eq 0 ] || { echo "Run as root."; exit 1; }

# ── The public hostnames ─────────────────────────────────────────────────────
# Defaults use sslip.io, which resolves any name containing an IP to that IP
# and needs no registration. See self-hosted-deploy.md §2.1 for why this is a
# fallback rather than the first choice: its Let's Encrypt rate-limit budget is
# shared with every other user of that domain.
IP="${LPR_IP:-$(hostname -I | awk '{print $1}')}"
API_HOST="${LPR_API_HOST:-api.${IP}.sslip.io}"
PARTICIPANT_HOST="${LPR_PARTICIPANT_HOST:-app.${IP}.sslip.io}"
RESEARCHER_HOST="${LPR_RESEARCHER_HOST:-research.${IP}.sslip.io}"
ACME_EMAIL="${LPR_ACME_EMAIL:-}"

[ -n "$ACME_EMAIL" ] || { echo "Set LPR_ACME_EMAIL=you@example.org and re-run."; exit 1; }

say "Packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq git docker.io docker-compose-v2 curl >/dev/null
systemctl enable --now docker >/dev/null 2>&1 || true

# Swap only where the first build would otherwise be OOM-killed. `next build`
# dies with an opaque exit code rather than an out-of-memory message, which is
# why this is worth doing up front instead of diagnosing later.
if [ "$(free -m | awk '/^Mem:/{print $2}')" -lt 4096 ] && [ ! -f /swapfile ]; then
  say "Swap (instance is under 4 GB)"
  fallocate -l 2G /swapfile && chmod 600 /swapfile
  mkswap /swapfile >/dev/null && swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >>/etc/fstab
fi

say "Code"
if [ -d "$DIR/.git" ]; then
  git -C "$DIR" fetch --depth 1 origin "$BRANCH"
  git -C "$DIR" checkout -f "$BRANCH"
  git -C "$DIR" reset --hard "origin/$BRANCH"
else
  git clone --depth 1 --branch "$BRANCH" "$REPO" "$DIR"
fi

say "Configuration"
if [ -f "$ENV_FILE" ]; then
  warn "$ENV_FILE exists — keeping it. Secrets are NOT regenerated."
else
  cp "$DIR/infrastructure/compose/.env.production.example" "$ENV_FILE"
  chmod 600 "$ENV_FILE"

  set_env() { sed -i "s|^$1=.*|$1=$2|" "$ENV_FILE"; }
  set_env API_HOST "$API_HOST"
  set_env PARTICIPANT_HOST "$PARTICIPANT_HOST"
  set_env RESEARCHER_HOST "$RESEARCHER_HOST"
  set_env ACME_EMAIL "$ACME_EMAIL"
  set_env POSTGRES_PASSWORD "$(openssl rand -hex 32)"
  set_env SESSION_SECRET "$(openssl rand -hex 48)"
  set_env VAPID_SUBJECT "mailto:$ACME_EMAIL"

  say "VAPID keys (ADR-006)"
  VAPID_JSON="$(docker run --rm node:20-alpine npx -y web-push generate-vapid-keys --json 2>/dev/null | tail -1)"
  VAPID_PUB="$(echo "$VAPID_JSON" | sed -n 's/.*"publicKey":"\([^"]*\)".*/\1/p')"
  VAPID_PRIV="$(echo "$VAPID_JSON" | sed -n 's/.*"privateKey":"\([^"]*\)".*/\1/p')"
  if [ -n "$VAPID_PUB" ] && [ -n "$VAPID_PRIV" ]; then
    set_env VAPID_PUBLIC_KEY "$VAPID_PUB"
    set_env VAPID_PRIVATE_KEY "$VAPID_PRIV"
  else
    warn "VAPID generation failed. Notifications will be recorded but not sent."
    warn "Fill VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY in $ENV_FILE and restart."
  fi
fi

say "Build and start — this takes 15-30 minutes the first time"
$COMPOSE up -d --build

say "Status"
$COMPOSE ps

cat <<BANNER

────────────────────────────────────────────────────────────────────────────
  https://$PARTICIPANT_HOST      participants
  https://$RESEARCHER_HOST   researchers
  https://$API_HOST/health   API

  NEXT, IN THIS ORDER:

  1. Copy the VAPID pair OFF this machine. Losing it and generating a new
     one permanently deactivates every participant's notifications, with no
     server-side repair:
       grep VAPID $ENV_FILE

  2. Confirm the worker is sweeping. A worker that is not sweeping is a
     platform where no session ever opens and no reminder ever fires:
       $COMPOSE logs worker | grep -i sweep

  3. Create the first researcher account (no registration endpoint exists,
     deliberately):
       $COMPOSE exec api node dist/scripts/create-researcher.js \\
         --email you@institution.org --name "Your Name" --admin

  4. Set up backups — docs/runbooks/self-hosted-deploy.md §6. An untested
     backup is not a backup (NFR-18).
────────────────────────────────────────────────────────────────────────────

BANNER
