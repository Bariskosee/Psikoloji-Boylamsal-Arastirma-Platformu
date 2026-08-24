# Oracle Cloud Always Free — single-VM production deployment

This directory is the Oracle-specific production layer for ADR-012. It keeps
the existing Participant Next.js app, Researcher Next.js dashboard, NestJS API,
always-on worker, PostgreSQL 16, pg-boss and reconciliation sweepers unchanged.
The Render blueprints remain supported and are not modified.

## $0 resource envelope

The current Oracle allowance is 1,500 A1 OCPU-hours and 9,000 A1 GB-hours per
month, equivalent to 2 OCPU and 12 GB continuously. In a 31-day month this VM
uses 1,488 OCPU-hours and 8,928 GB-hours. The intended bill of materials is:

- one `VM.Standard.A1.Flex`, 2 OCPU, 12 GB, marked **Always Free-eligible**;
- Canonical Ubuntu 24.04 Minimal aarch64, shown as **Free**;
- the default 46.6/50 GB boot volume, with no custom performance and no extra
  block volume (well inside the 200 GB home-region allowance);
- one Oracle-assigned ephemeral public IPv4;
- the existing VCN, public subnet and internet gateway;
- no OCI load balancer, managed database, paid DNS, reserved public IP or
  Object Storage bucket.

Stop if the console loses the Always Free marker, the image price is not Free,
another A1 instance/volume consumes the allowance, or creation reports a paid
resource. Free Trial credits are not proof of a permanent $0 configuration.

## Public network

The VM needs only these TCP ingress rules:

| Port | Source | Purpose |
|---|---|---|
| 22 | the operator's current public IPv4 `/32` | SSH |
| 80 | `0.0.0.0/0` | ACME redirect/challenge |
| 443 | `0.0.0.0/0` | HTTPS |

Do not add ingress for 5432, 3000, 3001, 3002 or any pg-boss port. Compose
publishes only 80 and 443; PostgreSQL is reachable only on the Docker network.

Oracle Ubuntu images also carry a host firewall. After first SSH login:

```bash
sudo iptables -I INPUT -p tcp --dport 80 -j ACCEPT
sudo iptables -I INPUT -p tcp --dport 443 -j ACCEPT
sudo netfilter-persistent save
```

## VM bootstrap

```bash
sudo apt update
sudo DEBIAN_FRONTEND=noninteractive apt upgrade -y
sudo DEBIAN_FRONTEND=noninteractive apt install -y \
  docker.io docker-compose-v2 git curl ca-certificates python3 \
  iptables-persistent postgresql-client restic util-linux
sudo systemctl enable --now docker
sudo usermod -aG docker "$USER"
```

Log out and reconnect once so group membership applies. Then:

```bash
sudo mkdir -p /opt/psikoloji-platform /var/backups/lpr /var/log/lpr
sudo chown -R "$USER":"$USER" \
  /opt/psikoloji-platform /var/backups/lpr /var/log/lpr
chmod 700 /var/backups/lpr /var/log/lpr

git clone https://github.com/Bariskosee/Psikoloji-Boylamsal-Arastirma-Platformu.git \
  /opt/psikoloji-platform
cd /opt/psikoloji-platform
```

Choose the origin mode before generating secrets. An ephemeral-IP `sslip.io`
origin is explicitly smoke-only:

```bash
infrastructure/oracle/bootstrap-env.sh \
  --smoke-test-ip <EPHEMERAL_PUBLIC_IPV4> --acme-email <OPERATIONS_EMAIL>
infrastructure/oracle/deploy.sh
```

Never enroll real participants in that mode. An IP change changes the origin,
invalidating continuity cookies and every push subscription. Participant mode
requires one of these stable choices:

```bash
# Stable registered names; DNS may later point at a different VM/IP.
infrastructure/oracle/bootstrap-env.sh \
  --domain study.example.org --acme-email <OPERATIONS_EMAIL>

# Or three existing stable names.
infrastructure/oracle/bootstrap-env.sh \
  --hostnames api.example.org join.example.org dashboard.example.org \
  --acme-email <OPERATIONS_EMAIL>

# Or only after the operator has verified the OCI address is reserved.
infrastructure/oracle/bootstrap-env.sh \
  --reserved-ip <RESERVED_PUBLIC_IPV4> --acme-email <OPERATIONS_EMAIL>
```

The script records `DEPLOYMENT_MODE` and `ORIGIN_MODE`, validates the names and
ACME contact, and refuses to overwrite `.env.production`; redeploys therefore
cannot silently rotate VAPID. It cannot verify an OCI reservation or a DNS
registration. Those remain explicit human launch attestations.

## What starts, and in what order

PostgreSQL first initialises the two NOLOGIN group roles and a separate,
non-superuser `lpr_app` login. Migrations run with the bootstrap administrator.
API and worker are gated on successful one-shot `migrate` and `queue-migrate`
containers. The restricted runtime login owns only the `pgboss` schema;
`queue-migrate` removes pg-boss's redundant database-level schema creation from
its vendor construction plan, so the login never receives `CREATE` on the
database. The worker then continuously updates its heartbeat. Caddy starts only
after the API and both frontends are healthy, then obtains and renews TLS
certificates automatically.

`migrate` and `queue-migrate` are one-shot. PostgreSQL, API, worker, both Next.js
apps and Caddy all use `restart: unless-stopped`, and Docker is enabled at boot.
The frontends and Caddy use only the `web` network; only API/worker and the
one-shots can join PostgreSQL's internal `data` network.

Docker does not restart a container merely because its health becomes
`unhealthy`. Enable user lingering and install the operations timers after
reconnecting:

```bash
sudo loginctl enable-linger "$USER"
infrastructure/oracle/install-systemd.sh
```

The installer fails unless `loginctl` confirms lingering, because an active
user timer without lingering disappears after the SSH user logs out or the VM
reboots.

The health timer requires two consecutive unhealthy observations before it
acts, restarts only an allowlisted Compose service, waits for recovery, and
enforces per-service/global cooldown limits. PostgreSQL is monitor-only so a
disk, OOM or recovery incident cannot become an automatic database restart
loop. Deploy and backup operations share a lock with the watchdog. Only a full,
successful scan atomically refreshes its success marker; participant readiness
requires that evidence to be no more than five minutes old. Inspect it with:

```bash
systemctl --user list-timers 'lpr-*'
journalctl --user -u lpr-health-recovery.service --since today
cat "${XDG_STATE_HOME:-$HOME/.local/state}/lpr-oracle-recovery/health-recovery-success"
```

## Verify the first deployment

```bash
infrastructure/oracle/verify.sh
infrastructure/oracle/compose.sh logs --tail=200 worker
```

Required evidence:

- `migrate` and `queue-migrate` are `Exited (0)` and the database migration
  ledger count matches the repository journal;
- `/health` is 200;
- `/ready` is 200, `ready=true`, and every returned check has `ok=true`;
- worker is healthy, the sweeper list is nonempty and fresh,
  `consecutive_failures=0`, and authenticated Operations alerts are empty;
- the runtime database user is non-superuser;
- all three public URLs have valid HTTPS.

`/ready` alone does not prove the worker is alive after pg-boss has once been
installed. The heartbeat and Operations page are separate mandatory checks.

## First researcher

There is intentionally no public registration endpoint. Use the masked wrapper
so the password never appears in a shell argument, environment variable,
history, or process list:

```bash
infrastructure/oracle/create-admin.sh <EMAIL> "Research Administrator"
```

## Backups and restore drill

`install-systemd.sh` installs a persistent nightly backup timer and a weekly
Restic structural-check timer. Every local transaction contains a matched role
dump, database dump, recovery secret-bundle copy and SHA-256 manifest;
the `latest` marker is moved only after the local artifacts validate.

Smoke mode may retain only the local copy. Participant mode fails its nightly
job and readiness gate unless a remote Restic repository is configured. The
repository is client-side encrypted. No provider account, bucket, repository,
paid feature or OCI resource is created by these scripts.

First choose an off-VM destination and verify its current price/quota and data
residency in the live account. Then create user-owned private configuration:

```bash
sudo install -d -m 700 -o "$USER" -g "$USER" /etc/lpr/restic
install -m 600 /secure/input/restic-repository /etc/lpr/restic/repository
install -m 600 /secure/input/restic-password /etc/lpr/restic/password

# Only when the backend needs credential environment variables:
cp infrastructure/oracle/restic/backend.env.example /etc/lpr/restic/backend.env
chmod 600 /etc/lpr/restic/backend.env

cp infrastructure/oracle/restic/cost-residency-approval.example \
  /etc/lpr/restic/cost-residency-approval
chmod 600 /etc/lpr/restic/cost-residency-approval

# Copy this exact lowercase digest into REPOSITORY_SHA256 in the approval file.
sha256sum /etc/lpr/restic/repository
```

`repository` and `password` each contain exactly one line. Store the encryption
password in a second secure off-VM location separate from the Restic data. Give
backend credentials access only to the selected bucket/path. Complete the
approval record with the checked destination, region, exact repository-file
SHA-256, current `$0` conclusion and stable-origin confirmation. Real participant
mode additionally requires a provider/account-side control that rejects billable
overage; a budget alert is not enforcement. Set
`NO_BILLABLE_OVERAGE_ENFORCED=yes` only after verifying that control in the live
account. If the selected provider cannot enforce it, this zero-cost deployment
must not enroll participants.

`MAX_REPOSITORY_BYTES` is a conservative client-side preflight threshold. Set it
at least 64 MiB below the provider's enforced free-storage ceiling, but do not
treat it as a billing cap: Restic raw-data statistics do not include every
provider-billed object and another writer can race a local check. The approval
date must be within the last 30 days. It is intentionally human evidence: code
cannot prove future billing or that a public IP is reserved.

Initialize the already-approved empty repository manually—nightly jobs never
run `init`—then produce and test the first encrypted snapshot:

```bash
infrastructure/oracle/restic-command.py init
infrastructure/oracle/backup.sh
infrastructure/oracle/check-offsite-backup.sh
infrastructure/oracle/restore-offsite-drill.sh
```

The drill downloads the encrypted snapshot into a mode-700 temporary directory,
restores it into an isolated PostgreSQL container with no host port, and checks
the migration ledger, triggers/constraints, pg-boss queues, research access and
identity denial. Its evidence expires after 90 days. The weekly `restic check`
is structural; a full pack-read schedule needs separate quota approval. Uploads
measure `restic stats --mode raw-data` before and after writing and refuse to
start above the conservative `MAX_REPOSITORY_BYTES` projection. The enforced
provider/account no-overage control—not this preflight—is the cost boundary.
Snapshots are not pruned automatically because provider request costs and
retention/immutability rules differ. Approve a provider-specific retention
action before the threshold is approached; after changing the threshold, rerun
the structural check and create a new backup so evidence agrees.

After total VM/state loss, recreate the private Restic repository, password,
required backend credential and current cost/residency approval files from their
separately stored recovery copies. Recompute `REPOSITORY_SHA256` and reverify the
provider/account no-overage control before downloading data. The normal drill
deliberately requires the local success marker; the explicit recovery mode
instead selects the newest authenticated
`lpr-oracle-prod`/`lpr-nightly` snapshot, verifies its exact transaction manifest,
performs the full isolated PostgreSQL drill, and leaves a private recovery bundle:

```bash
install -d -m 700 "$HOME/lpr-recovery"
infrastructure/oracle/restore-offsite-drill.sh \
  --fresh-vm-recovery "$HOME/lpr-recovery/latest"
```

The target must not already exist. Its mode is `0700`; its dumps, production
secret bundle, manifest and `recovery-evidence` are `0600`. Treat the directory
as production psychological-study data and remove it securely after recovery.

Finally run the fail-closed enrollment gate:

```bash
infrastructure/oracle/participant-readiness.sh
```

It also runs normal deployment verification and requires verified systemd user
lingering, enabled timers, a fresh (<5m) successful watchdog scan, a fresh
(<26h) local/remote matched transaction, successful remote restore and hash
comparison, a <7-day Restic check, and a <90-day PostgreSQL restore drill.
This operational gate does not replace consent approval, protocol review or the
real-device dry run in `docs/runbooks/study-launch-checklist.md`.

## Updating and reboot verification

```bash
infrastructure/oracle/update.sh
sudo reboot
# reconnect, then:
infrastructure/oracle/verify.sh
```

`update.sh` takes a fresh logical backup before pulling or migrating.

Check `df -h`, `free -h`, `docker stats --no-stream`, PostgreSQL volume size and
backup retention periodically. A1 Always Free instances have no SLA and can be
reclaimed for sustained idleness; this deployment cannot provide failover from
one VM.
