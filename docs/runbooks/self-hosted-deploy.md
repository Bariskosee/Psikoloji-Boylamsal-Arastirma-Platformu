# Runbook — self-hosted deployment on one VM

**Audience:** the person who administers the deployment. **Time:** two to three hours the first time, most of it waiting.

This is the procedure for ADR-012: the whole platform on a single virtual machine. Nothing below is provider-specific except §1 — it is a Linux VM with Docker. The current deployment is a TuemCloud *Advanced VDS* in Türkiye; §1 also keeps the Oracle Always Free variant, because ADR-012's original target remains valid for anyone reproducing this without a budget.

**Read §1.5 before you spend an hour debugging a firewall.** It is the single most common way this deployment wastes an afternoon.

---

## 1. The machine

### 1.1 Create it

Any **Ubuntu LTS** VM with at least **4 GB of RAM**. The running stack is capped at about 2.6 GB by the memory limits in the compose file, and the first build needs headroom above that. Architecture does not matter — every base image used is multi-architecture — but see §4 on build times.

**The current deployment** is a TuemCloud *Advanced VDS* located in Türkiye. That choice answers `REQUIREMENTS.md` §10 item 4 in the strongest form available: participant data never leaves the country, so the ethics submission carries no cross-border transfer to declare. ADR-012's amendment note records the reasoning.

> **In practice the country is chosen once.** Moving a running study to another jurisdiction means moving the database, the DNS, the certificates and every participant's stored session — and re-describing data residency to the ethics committee mid-study. Decide before enrollment opens, not after.

**The Oracle Always Free variant.** ADR-012's original target was an Ampere A1 (ARM) instance in an EU region. It still works and still costs nothing, with two caveats this deployment hit: Ampere capacity is frequently unavailable (`OUT_OF_HOST_CAPACITY`), and the home region cannot be changed after the account is created, which forecloses Turkish residency permanently.

Add your SSH public key during creation. The database is small — a 22-participant pilot was about 13 MB — but logs and backups accumulate.

### 1.2 Lock down SSH before anything else

Turkish VDS providers typically hand over a root account with a password they emailed you. That is an internet-facing password on a machine that will hold psychological research data, and it is being brute-forced within hours of the IP going live.

```bash
ssh-copy-id root@<public ip>      # from your laptop, if you did not add a key at creation
```

Then on the VM:

```bash
sudo sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config
sudo sed -i 's/^#\?PermitRootLogin.*/PermitRootLogin prohibit-password/' /etc/ssh/sshd_config
sudo systemctl restart ssh
```

**Keep your current session open** and confirm a new one works before closing it — a typo here locks you out of a machine you cannot console into.

Also change the provider-supplied password in the panel even after disabling password login: it is often reused for the panel's own rescue console.

### 1.3 Basics

```bash
sudo apt update && sudo apt upgrade -y
sudo apt install -y docker.io docker-compose-v2 git
sudo usermod -aG docker "$USER"   # log out and back in
```

### 1.4 Swap, if the instance is small

A 4 GB instance running the stack does not need swap, but the **first build** compiles four applications and is the peak. On anything at or below 4 GB, add 2 GB of swap or the Next.js build will be killed mid-compile — an OOM kill during `next build` presents as an opaque exit code, not as an out-of-memory message:

```bash
sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile
sudo mkswap /swapfile && sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
```

### 1.5 Open the ports — check for **two** firewalls

This is the step that traps everyone. A port can be blocked at the provider *and* on the VM, and opening only one leaves it silently unreachable — the connection just hangs, which reads as a broken application rather than as a firewall.

**At the provider.** TuemCloud and most Turkish VDS providers apply no cloud-level filter by default; check the panel's firewall page and, if there is none, there is nothing to do here. On Oracle there is: VCN → your subnet → Security List → ingress rules for TCP **80** and **443** from `0.0.0.0/0`.

**On the VM.** Which tool applies depends on the image:

```bash
sudo ufw allow 22/tcp && sudo ufw allow 80/tcp && sudo ufw allow 443/tcp
sudo ufw enable          # confirm 22 is in the list first, or you lose the session
```

Oracle's Ubuntu images instead ship restrictive `iptables` rules:

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

### 2.1 If you have no domain

A free subdomain from a dynamic-DNS provider is a real HTTPS origin: Caddy obtains a Let's Encrypt certificate for it, Web Push works, and the participant app installs to an iPhone Home Screen. What does **not** work is a bare IP address — no certificate, so no push and no install, which is most of the platform.

The current deployment uses this path. DuckDNS is the recommended provider: register one name (`<yours>.duckdns.org`), point it at the VM's IP, and all three hostnames become subdomains of it:

```text
api.<yours>.duckdns.org
app.<yours>.duckdns.org
research.<yours>.duckdns.org
```

Verify before the first `up` that sub-subdomains actually resolve — providers differ on whether they answer for names below the one you registered:

```bash
dig +short app.<yours>.duckdns.org      # must print the VM's IP
```

If they do not resolve, `sslip.io` needs no registration at all and answers for any name containing the IP — `app.5.180.186.24.sslip.io`. It is a fallback rather than the first choice: its Let's Encrypt rate-limit budget may be shared with every other user of that domain.

### 2.2 Choose the participant hostname before enrollment opens

> **A Web Push subscription is bound to its origin.** If `app.<domain>` changes after participants have installed the application, every one of their subscriptions becomes unreachable and each participant must install and re-subscribe on their own device. There is no server-side repair. This is the same failure class as rotating the VAPID pair (§3), arrived at from a different direction — and moving from a free subdomain to an institutional domain mid-study triggers it.

The practical consequence: a free subdomain is fine for the **pilot**, where participants are few and reachable. Before the real study opens enrollment, decide whether the participant application will live on an institutional domain — and if so, move to it *first*. A `duckdns.org` link is also weaker in a recruitment message and in an ethics submission than a university-adjacent name.

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

The first build takes roughly fifteen to thirty minutes — it compiles four applications. Subsequent builds reuse the layer cache. If it dies without a clear error, it was the OOM killer: add the swap from §1.4 and run it again.

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
- **The invoice.** This deployment is a paid monthly VDS. An unpaid renewal suspends the machine, and a suspended machine stops the sweepers — the silent scheduling death ADR-012 exists to avoid. Put the renewal date in a calendar with a reminder, and do not rely on the provider's email reaching a monitored inbox.
- **The instance itself**, if you are on Oracle Always Free instead: idle always-free resources can be reclaimed. A running study keeps the machine busy; a study that has not started yet does not.
- **`docker compose ps`** after any reboot. Everything is `restart: unless-stopped`, so this should be automatic; confirm it once rather than assuming.
