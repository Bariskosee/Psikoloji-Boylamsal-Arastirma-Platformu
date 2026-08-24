# Runbook — self-hosted deployment on one VM

**Audience:** the person who administers the deployment. **Time:** two to three hours the first time, most of it waiting.

This is the procedure for ADR-012: the whole platform on a single always-free virtual machine. It is written for Oracle Cloud's Always Free Ampere A1 in an EU region, but nothing below is Oracle-specific except §1 — it is a Linux VM with Docker.

**Read §1.4 before you spend an hour debugging a firewall.** It is the single most common way this deployment wastes an afternoon.

---

## 1. The machine

### 1.1 Create it

An **Ampere A1 (ARM)** instance, Ubuntu LTS, in an EU region close to Türkiye. Check your tenancy for the current Always Free allowance — Oracle states it in the console, and it has changed over time. Two OCPU and 12 GB is far more than this platform needs; the stack is capped at about 2.6 GB by the memory limits in the compose file.

> **The home region cannot be changed after the account is created.** If the ethics approval might require data to stay in Türkiye, decide before you create the account, not after. `REQUIREMENTS.md` §10 lists this as an open question — answer it first.

Add your SSH public key during creation. Give the boot volume whatever the free allowance permits; the database is small (a 22-participant pilot was about 13 MB) but logs and backups accumulate.

### 1.2 Basics

```bash
sudo apt update && sudo apt upgrade -y
sudo apt install -y docker.io docker-compose-v2 git
sudo usermod -aG docker "$USER"   # log out and back in
```

### 1.3 Swap, if the instance is small

Ampere A1 with 12 GB needs none. On a 1–2 GB instance, add 2 GB of swap or the Next.js build will be killed mid-compile:

```bash
sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile
sudo mkswap /swapfile && sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
```

### 1.4 Open the ports — **both** firewalls

This is the step that traps everyone. Oracle's Ubuntu images ship with restrictive local `iptables` rules **in addition to** the cloud-level security list, and opening only one leaves the port silently unreachable — the connection just hangs, which reads as a broken application rather than as a firewall.

**In the Oracle console:** VCN → your subnet → Security List → add ingress rules for TCP **80** and **443** from `0.0.0.0/0`.

**On the VM:**

```bash
sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 80 -j ACCEPT
sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 443 -j ACCEPT
sudo netfilter-persistent save
```

Verify from your laptop, before going further: `nc -vz <public ip> 443` should connect, not hang.

## 2. DNS

Point all three hostnames at the VM's public IP with `A` records, and wait for them to resolve:

| Host | Serves |
|---|---|
| `app.<domain>` | the participant application |
| `research.<domain>` | the researcher dashboard |
| `api.<domain>` | the API |

Three names, not one. The participant application and the researcher dashboard are separate origins by ADR-009: a compromised researcher session must not be same-origin with participant data.

**They must resolve before the first `up`.** Caddy obtains certificates on start, and Let's Encrypt rate-limits repeated failures.

If you have no domain yet: a free subdomain from any dynamic-DNS provider works, and `PLAN.md` gate G9 permits recording the deferral — but **Web Push does not work without HTTPS on a real name**, and neither does installing the participant app to an iPhone Home Screen. That is most of the platform.

## 3. The code and the configuration

```bash
sudo mkdir -p /opt/lpr && sudo chown "$USER" /opt/lpr
git clone <your repository> /opt/lpr && cd /opt/lpr

cp infrastructure/compose/.env.production.example .env.production
```

Fill in `.env.production`. Generate the secrets rather than inventing them:

```bash
openssl rand -base64 48   # SESSION_SECRET
openssl rand -base64 32   # POSTGRES_PASSWORD
npx web-push generate-vapid-keys
```

> **Copy the VAPID pair somewhere off this machine before you paste it in.** A
> push subscription is bound to the public key it was created with. Rotating
> the pair deactivates every participant's notifications **permanently**, with
> no server-side repair — every one of them must re-enable it on their own
> device. Treat it as study data, not as configuration.
> (`docs/runbooks/push-failure-triage.md` §2.)

`.env.production` is covered by `.gitignore` and must never be committed (NFR-16).

## 4. Start it

```bash
docker compose -f infrastructure/compose/docker-compose.yml \
  --env-file .env.production up -d --build
```

The first build takes fifteen to thirty minutes on ARM — it compiles four applications. Subsequent builds reuse the layer cache.

What happens, in order: PostgreSQL starts and its first-run script creates the two NOLOGIN group roles; the `migrate` container applies the migrations and exits; the API, worker and both frontends start; Caddy obtains certificates.

```bash
docker compose -f infrastructure/compose/docker-compose.yml --env-file .env.production ps
docker compose -f infrastructure/compose/docker-compose.yml --env-file .env.production logs -f worker
```

The worker's startup line names its sweepers and interval. **If you do not see sweep lines, stop and read `sweeper-stall.md`** — a worker that is not sweeping is a platform where nothing will ever open.

## 5. The first researcher account

There is no registration endpoint, deliberately: self-service signup on a platform holding psychological research data would let anyone who finds the dashboard start a study.

```bash
docker compose -f infrastructure/compose/docker-compose.yml --env-file .env.production \
  exec api node dist/scripts/create-researcher.js --email you@institution.org --name "Your Name" --admin
```

The password is read from stdin, never from the command line.

## 6. Backups — do this now, not later

NFR-18: an untested backup is not a backup.

```bash
crontab -e
# 17 3 * * * cd /opt/lpr && sh infrastructure/compose/backup.sh >> /var/log/lpr-backup.log 2>&1
```

Then **run it once by hand** and **restore it once** into a throwaway database, following `restore-drill.md`. A backup regime that has never been restored is a guess, and the drill has already found one thing that would have bitten you: `pg_dump` does not include roles, so restoring the data alone silently loses the NFR-03 analytics boundary while every row arrives intact.

Copy the dumps off this machine. A backup on the same disk as the database survives a dropped table and not a lost instance.

**What this does not give you:** point-in-time recovery. Between two nightly runs there is up to a day of responses a restore would lose. If the ethics approval requires better, WAL archiving to off-site storage has to be added — recorded in ADR-012 as an open item rather than pretended away.

## 7. Verify, in this order

Machinery before application:

```bash
curl -s https://api.<domain>/health   # 200
curl -s https://api.<domain>/ready    # 200, BOTH checks ok
```

Then work through **`study-launch-checklist.md`** §5 and §6 — the operations page, and the dry run on a real phone. The phone is not optional: iOS delivers Web Push only to an application installed to the Home Screen, and that is the single most common way a study discovers on day one that half its participants receive nothing.

## 8. Updating

```bash
cd /opt/lpr && git pull
docker compose -f infrastructure/compose/docker-compose.yml --env-file .env.production up -d --build
```

The `migrate` container runs before the API restarts. Migrations are written to be backward-compatible with the previous release, so rolling the code back without rolling the database back is safe.

**Changing `API_HOST` requires a rebuild, not a restart.** `NEXT_PUBLIC_API_URL` is inlined into the frontends' JavaScript at build time; set it afterwards and both applications call `localhost:3001` from your users' browsers, failing with a CORS error that looks like a server fault.

## 9. What to watch

- **The operations page**, weekly. An empty sweeper list means scheduling has stopped.
- **Disk.** `df -h`. Logs are capped at 50 MB per service by the compose file; backups are not, beyond their fourteen-day retention.
- **The instance itself.** Always-free resources can be reclaimed when idle. A running study keeps the machine busy, but a study that has not started yet does not — check the instance exists before you need it.
- **`docker compose ps`** after any reboot. Everything is `restart: unless-stopped`, so this should be automatic; confirm it once rather than assuming.
