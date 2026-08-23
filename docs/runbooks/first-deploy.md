# Runbook — the first deploy

**Audience:** whoever administers the deployment. **Time:** about an hour, most of it waiting for builds.

This is the procedure for standing up an environment that has never existed. It is written for **staging first** — Phase 13's opening step — and the production run is the same procedure with the other blueprint and one extra section at the end.

**Nothing here is optional.** Two of the steps cannot be inferred from any error message the platform will show you, and one of them (§3) breaks every analytics screen in a way that names neither the cause nor the fix.

---

## 0. Before you start

You need:

- A Render account with a payment method. **The free tier is not usable for this platform**: it spins services down when idle, and an idled worker stops the reconciliation sweepers — at which point sessions silently stop opening and no error appears anywhere (ADR-005, ADR-010). The blueprint pins `starter` for that reason.
- Two hostnames for staging, and later two for production. The participant application and the researcher dashboard are separate origins by ADR-009 and must stay that way.
- A VAPID key pair (§4). Generate it now and store it where it will survive this deployment.
- Optionally, SMTP credentials. Without them the platform still works and researcher password-reset links are written to the API log with a startup warning — acceptable for staging, not for production.

**Staging must never hold real participant data.** Its database plan has no point-in-time recovery, and it is rebuilt freely.

## 1. Create the blueprint

In Render: **New → Blueprint**, point it at this repository, and choose the file:

- staging → `infrastructure/render.staging.yaml`
- production → `infrastructure/render.yaml`

Render will show four services and one database. **Do not click Apply yet** — the environment variables marked `sync: false` are blank and two of them are needed at build time.

## 2. Fill in the environment variables

Render prompts for every `sync: false` key. Values for staging:

| Service | Key | Value |
|---|---|---|
| api | `PARTICIPANT_ORIGIN` | `https://<participant host>` |
| api | `RESEARCHER_ORIGIN` | `https://<researcher host>` |
| api | `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` / `VAPID_SUBJECT` | from §4 |
| api | `SMTP_*`, `MAIL_FROM` | leave blank on staging |
| api, worker | `SENTRY_DSN` | blank, or a staging DSN |
| worker | `VAPID_*` | the same pair as the API |
| participant, researcher | `NEXT_PUBLIC_API_URL` | `https://<api host>` |

> **`NEXT_PUBLIC_API_URL` is inlined into the JavaScript bundle at BUILD time.**
> It is not read at run time. Setting it after the first build leaves both
> frontends calling `http://localhost:3001` from your users' browsers, which
> fails with a CORS error that looks like a server fault. If you change it
> later you must **rebuild**, not restart.

Do not set `PORT` or `API_PORT` anywhere. Render assigns the port and the services read it.

## 3. Create the two group roles — **before the first deploy**

This is the step that has no discoverable error message.

`app_readwrite` and `app_analytics` are NOLOGIN group roles. They are how NFR-03 is enforced *technically* rather than by convention: the analytics connection carries `role=app_analytics` in its startup packet, so the analytics code path is structurally unable to read the `identity` schema.

Migration `0000` creates them — but `CREATE ROLE` requires the `CREATEROLE` attribute, which a managed provider's database user usually does not have. If it does not, the first migration fails immediately and the deploy stops.

The migration entrypoint checks for this and prints the exact remedy. To avoid the failed deploy entirely, connect to the new database with `psql` (Render shows an external connection string) and run:

```sql
CREATE ROLE app_readwrite NOLOGIN;
CREATE ROLE app_analytics NOLOGIN;
GRANT app_readwrite, app_analytics TO CURRENT_USER;
```

Both statements are safe to run twice — migration `0000` skips roles that exist, and `0009` skips a membership already held.

**If you skip this:** either the first migration fails (visible, recoverable), or — if the roles exist but membership was not granted — every analytics screen fails, because the connection itself is refused. Monitoring, the participant list, distributions and export all break together while login and questionnaires keep working, which is a confusing signature.

## 4. Generate the VAPID pair

```bash
npx web-push generate-vapid-keys
```

`VAPID_SUBJECT` is a contact URI, e.g. `mailto:research@your-institution.org`.

> **Store the pair outside Render before you paste it in.** A push subscription
> is bound to the public key it was created with. Rotating the pair
> deactivates every existing subscriber **permanently** — there is no
> server-side repair, and every participant must re-enable notifications on
> their own device. `docs/runbooks/push-failure-triage.md` §2 covers the
> incident; this line is how you avoid it. Treat these as study data.

## 5. Apply, and watch the order

Render will build all four services. Expect:

1. `lpr-*-api` builds, then runs the pre-deploy migration (`migrate:deploy`), then starts and is health-checked at `/ready`.
2. `lpr-*-worker` builds and starts. Its first log line names the sweep interval.
3. The two frontends build and start.

**The API is deliberately "ready" before the worker exists.** `/ready` reports the job system as a failing check but keeps the service healthy, because participants can still open sessions and save answers without the queue — ADR-005 makes the sweepers, not the queue, the correctness guarantee. Draining a healthy API because the worker is slow to boot would turn a degraded feature into an outage.

## 6. Attach the hostnames

Add the custom domains to `lpr-*-participant`, `lpr-*-researcher` and `lpr-*-api`, and wait for the certificates. **Web Push does not work without HTTPS on a real domain** (NFR-01), and neither does installing the participant application to an iPhone Home Screen — which is the only way iOS delivers push at all.

If the hostnames differ from what you typed in §2, correct `PARTICIPANT_ORIGIN`, `RESEARCHER_ORIGIN` and `NEXT_PUBLIC_API_URL` now, and **rebuild the two frontends** (§2's warning).

## 7. Create the first researcher account

There is no registration endpoint — deliberately. Self-service signup on a platform holding psychological research data would let anyone who finds the dashboard start a study.

From a shell on the API service:

```bash
pnpm --filter=@lpr/api researcher:create -- --email you@institution.org --name "Your Name" --admin
```

The password is read from stdin, never from the command line — a password in `argv` is visible in `ps`, in shell history and in process logs. `--admin` is what grants access to the operations page; grant it sparingly.

## 8. Verify, in this order

Do not skip to the application. Check the machinery first.

```bash
curl -s https://<api host>/health   # 200
curl -s https://<api host>/ready    # 200, and now BOTH checks ok
```

Then, in the dashboard:

- [ ] Sign in as the account from §7.
- [ ] Open **Operations**. Sweeper heartbeats must be present and fresh, `consecutive failures` 0, and the alert list empty. **An empty sweeper list means scheduling is not running** — go to `docs/runbooks/sweeper-stall.md`.
- [ ] Create a throwaway study, publish a questionnaire and a protocol, activate it.
- [ ] Enrol as a participant **from a phone**, using the QR code, over the real hostname.
- [ ] Install to the Home Screen, grant notifications, and confirm one arrives. On iOS this only works once installed — see ADR-007.
- [ ] Answer a session; confirm the response appears in the inspector as `ANSWERED`.
- [ ] Download `long.csv`; confirm Turkish characters survive and empty cells carry a status column.
- [ ] Withdraw the participant; confirm no further notification arrives.

`docs/runbooks/study-launch-checklist.md` is the fuller version of this list, and is what runs before a *real* study rather than before a smoke test.

## 9. Production only — before real participants

Everything above, plus:

- [ ] Confirm the database plan supports **point-in-time recovery**, and run `docs/runbooks/restore-drill.md` against this provider. NFR-18: an untested backup is not a backup, and the drill has so far only been executed against a local instance.
- [ ] Configure SMTP, and prove a password reset actually arrives.
- [ ] Configure alerting on the sweeper heartbeat and on the `/api/ops/health` alert list. Nothing in the repository does this for you; the alerts are computed and exposed, and the paging is the institution's choice.
- [ ] Name someone on call, and make sure they know `docs/runbooks/` exists.
- [ ] Complete `study-launch-checklist.md` **with the researcher present**. Several items on it are research decisions, not engineering ones.

## 10. Rolling back

Render keeps previous deploys. Roll back the service; **do not roll back the database**. Migrations are written to be backward-compatible with the previous release precisely so that this is safe. If a migration itself is the problem, `docs/runbooks/restore-drill.md` is the procedure, and §5.1 of it is the finding that will bite you: `pg_dump` does not include roles, so a naive restore silently loses the NFR-03 boundary while every row arrives intact.
