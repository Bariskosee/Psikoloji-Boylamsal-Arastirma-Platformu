# Runbook — database restore drill

**Purpose:** prove that the backups can actually be restored, before the day it matters.

A backup that has never been restored is a guess. This procedure is written to be *executed on a schedule*, not read — the value is in the two or three things that go wrong each time, and both of the findings in §5 came from running it rather than from writing it.

**Cadence:** before a pilot begins, then quarterly, and after any change to roles, schemas, or the hosting provider.

---

## 1. What a restore must reproduce

Row counts are the easy part and the least interesting. A restore of this platform is only correct if **all four** of these survive:

| # | Property | Why it is load-bearing |
|---|---|---|
| 1 | Every row | Obvious, and rarely the thing that breaks. |
| 2 | The immutability triggers | ADR-008: a published questionnaire version cannot be altered, and a response under a completed session cannot be edited. These are enforced by **triggers**, not by application code. A restore that loses them leaves a database that accepts silent corruption of published research data. |
| 3 | The `app_analytics` privilege boundary | NFR-03: the analytics role may read `research` and must not reach `identity`. This is **schema-level GRANTs on roles**, and §5.1 is the reason this row exists. |
| 4 | The migration ledger | `drizzle.__drizzle_migrations`. Without it the next deploy tries to re-apply every migration from the beginning. |

## 1b. On the self-hosted deployment

`infrastructure/compose/backup.sh` already produces both files this procedure
needs — the roles dump and the data dump — into
`infrastructure/compose/backups/`, and it produces them in that order for the
reason §5.1 gives. The drill below is then a restore of the latest pair into a
throwaway container rather than a fresh `pg_dump`.

Note what self-hosting does not give you: there is no point-in-time recovery,
so "restore" means "restore to last night". ADR-012 records that as an open
item against NFR-18 rather than as satisfied, and closing it means WAL
archiving to off-site storage.

## 2. Take the backup

```bash
pg_dump   -U "$PGUSER" -d "$PGDATABASE" -Fc -f drill.dump
pg_dumpall -U "$PGUSER" --roles-only     -f roles.sql   # see §5.1 — not optional
```

On a managed provider, use its point-in-time restore to produce a new instance and skip to §4; §3 is for the self-managed case and for verifying a downloaded dump.

## 3. Restore into a **clean, separate** instance

Never into the live database, and never into an instance anything else points at. A drill that can damage production is not a drill.

```bash
docker run -d --name restore-drill \
  -e POSTGRES_USER=lpr -e POSTGRES_PASSWORD=… -e POSTGRES_DB=lpr -p 5446:5432 postgres:16

# Poll over TCP, NOT the local socket — see §5.2.
until pg_isready -h 127.0.0.1 -p 5446 -U lpr; do sleep 1; done

psql       -h 127.0.0.1 -p 5446 -U lpr -d postgres -f roles.sql   # roles FIRST
pg_restore -h 127.0.0.1 -p 5446 -U lpr -d lpr --clean --if-exists drill.dump
```

`role "lpr" already exists` from `roles.sql` is expected and harmless — the container created it. Any *other* role error means step §5.1 is about to bite.

## 4. Verify — all four properties, every time

```sql
-- 1. Rows. Compare against the same query run on the source before the dump.
SELECT (SELECT count(*) FROM research.studies)              AS studies,
       (SELECT count(*) FROM research.participants)         AS participants,
       (SELECT count(*) FROM research.participant_sessions) AS sessions,
       (SELECT count(*) FROM research.responses)            AS responses;

-- 2. Structure, including the triggers that enforce immutability.
SELECT (SELECT count(*) FROM information_schema.tables
         WHERE table_schema IN ('research','identity'))              AS tables,
       (SELECT count(*) FROM pg_trigger WHERE NOT tgisinternal)      AS triggers,
       (SELECT count(*) FROM pg_constraint WHERE contype = 'f')      AS foreign_keys,
       (SELECT count(*) FROM pg_indexes
         WHERE schemaname IN ('research','identity'))                AS indexes;

-- 4. The migration ledger.
SELECT count(*) FROM drizzle.__drizzle_migrations;
```

```bash
# 3. The privilege boundary, asserted in BOTH directions. One direction is not
#    a test: a role with no grants at all passes the "denied" half perfectly.
psql … -c "SET ROLE app_analytics; SELECT count(*) FROM identity.push_subscriptions;"
#   must fail:    ERROR: permission denied for schema identity
psql … -c "SET ROLE app_analytics; SELECT count(*) FROM research.studies;"
#   must succeed
```

## 5. Findings from the drill executed 2026-08-23

Environment: PostgreSQL 16 in Docker on a developer machine; source database 13 MB, 31 tables, 64 sessions.

| Step | Measured |
|---|---|
| `pg_dump -Fc` | < 1 s (142 KB dump) |
| Clean instance boot to accepting connections | 2 s |
| `pg_restore` | < 1 s |
| Verification queries | < 1 s |

All four properties reproduced exactly: 2 studies / 2 participants / 64 sessions; 31 tables, 38 triggers, 47 foreign keys, 94 indexes — identical to source; 8 migrations in the ledger; `app_analytics` denied on `identity` with `permission denied for schema identity` and permitted on `research`.

**These timings do not extrapolate.** They are a 13 MB database on local disk. Re-measure against production volume and against the provider's actual restore path before quoting a recovery-time objective to anyone.

### 5.1 Finding — roles are **not** in the database dump

`pg_dump` of a single database does not include roles. Restoring it into a fresh instance therefore fails every `GRANT` and every `ALTER … OWNER`, and the failure is **partial and quiet**: the tables and the data arrive intact, so a verification that checks only row counts passes — while `app_analytics` does not exist and the NFR-03 boundary is simply absent.

On the first attempt this produced `role "app_readwrite" does not exist` repeatedly during `pg_restore`, and the resulting database looked fine.

**Consequence:** `pg_dumpall --roles-only` is part of the backup, not an extra, and it must be applied *before* `pg_restore`. A backup procedure that omits it is not a backup of this platform.

### 5.2 Finding — `pg_isready` reports ready during `initdb`

The official Postgres image runs an initialisation phase on a temporary local socket before starting the real listener. `pg_isready` against that socket answers *yes* while the server is not actually accepting connections, so the restore began too early and the roles step failed.

**Consequence:** poll over TCP (`-h 127.0.0.1`), as §3 does. This matters for CI and for any scripted restore, not just for the drill.

## 6. Tear down

```bash
docker rm -f restore-drill
```

Delete the dump. **A restored copy is a full copy of the study's psychological data** and carries every obligation the production database does. A forgotten drill container on a laptop is a data breach with extra steps.

## 7. Record the result

Append the date, the measured timings, and anything that went wrong to this file. The findings are the point; a drill that reports "fine" every time is a drill nobody is really running.

## 8. Related

- `docs/adr/ADR-003-database-and-data-access.md` — schemas, roles, and the boundary.
- `docs/adr/ADR-008-versioning-model.md` — the immutability triggers property 2 protects.
- `outage-recovery.md` — what to do after the restore, once the platform points at it.
