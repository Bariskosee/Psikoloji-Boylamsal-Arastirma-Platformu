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
  iptables-persistent postgresql-client
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

For an initial no-cost hostname, `bootstrap-env.sh` derives three distinct
`sslip.io` names from the public IPv4 and generates the database, session and
VAPID secrets without printing them:

```bash
infrastructure/oracle/bootstrap-env.sh <PUBLIC_IPV4>
infrastructure/oracle/deploy.sh
```

Do not rerun `bootstrap-env.sh`: it refuses to overwrite `.env.production` so
redeploys cannot rotate VAPID. Copy `.env.production` to a second encrypted,
access-controlled location before enrolling real participants.

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

## Verify the first deployment

```bash
infrastructure/oracle/verify.sh
infrastructure/oracle/compose.sh logs --tail=200 worker
```

Required evidence:

- `migrate` and `queue-migrate` are `Exited (0)` and all 10 application
  migrations are recorded;
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
infrastructure/oracle/create-admin.sh <EMAIL> "Baris Kose"
```

## Backups and restore drill

Install the user-owned nightly job:

```cron
17 3 * * * cd /opt/psikoloji-platform && infrastructure/oracle/backup.sh >> /var/log/lpr/backup.log 2>&1
```

Run it once immediately, verify both `roles-*.sql` and `lpr-*.dump` are
nonempty, then perform `docs/runbooks/restore-drill.md`. The roles dump must be
restored before the custom-format database dump; normal `pg_dump` does not
contain roles. On-VM backups do not survive a lost instance. Off-site storage
is deliberately not provisioned automatically because its $0 eligibility must
be checked against live account usage first. Do not enroll real participants
until an encrypted off-VM copy has been configured and restore-tested.

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
