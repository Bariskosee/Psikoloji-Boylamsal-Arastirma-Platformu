# Runbook — the sweepers have stalled

**Alert codes:** `SWEEPER_ABSENT`, `SWEEPER_STALE`, `SWEEPER_FAILING`
**Severity:** critical
**Why it is critical:** the reconciliation sweepers are what make the schedule *correct* (ADR-005). While they are stopped, sessions do not open, sessions do not expire, and reminders are not enqueued — **and nothing errors**. A stalled platform looks exactly like a quiet one. Participants notice before your monitoring does.

Time budget: decide within 15 minutes, because every stalled hour is participant sessions that opened late or not at all.

---

## 1. Read the alert, it already narrows it to one of three

| Code | What it means | What it does **not** mean |
|---|---|---|
| `SWEEPER_ABSENT` | `research.system_heartbeats` is empty. No worker has *ever* reported against this database. | Not necessarily an outage — a fresh or restored database looks identical. |
| `SWEEPER_STALE` | A worker reported once, then stopped. Three or more intervals missed. | The process may still be "running" as far as the host is concerned. |
| `SWEEPER_FAILING` | The loop is running on schedule and throwing every time. | **Not** a dead process. Restarting it will not help. |

## 2. Look at the evidence

Operations page → **Sweepers**, or directly:

```sql
SELECT worker_id, swept_at, now() - swept_at AS age,
       sweep_interval_seconds, consecutive_failures, last_error
  FROM research.system_heartbeats
 ORDER BY swept_at DESC;
```

`last_error` is the diagnosis for `SWEEPER_FAILING` and is usually the whole answer. Read it before touching anything.

## 3. Act on the case you have

### `SWEEPER_FAILING` — running, throwing

Do **not** restart. The loop is alive; a restart returns you to the same error one interval later having lost the log context.

1. Read `last_error` and the worker's logs around the same timestamp.
2. Most common causes, in the order they actually occur: a migration applied to the database but not deployed to the worker (or the reverse); a database role losing a grant; a `NOT NULL` added to a table a sweeper writes.
3. Fix the cause. The sweeper self-heals on its next cycle — `consecutive_failures` returns to `0` and the alert clears without intervention.

### `SWEEPER_STALE` — reported, then stopped

1. **Is the process alive?** Check the host. If it is not, this is ADR-010's warning arriving: a hosting tier that idles services out will do exactly this, silently, and will do it again. See §5.
2. If the process *is* alive but not sweeping, it is wedged — almost always a database connection that neither closed nor answered. Restart the worker.
3. After it restarts, go to §4. **Do not** manually adjust session rows first.

### `SWEEPER_ABSENT` — never reported

1. Is a worker deployed at all against this database? Check `DATABASE_URL` on the worker against the one the API uses. Pointing the worker at the wrong database produces exactly this alert and is the most common cause on a new environment.
2. If this is a freshly restored database, this is expected until the worker attaches. See `restore-drill.md`.

## 4. After recovery — confirm convergence, do not force it

The sweepers are self-healing by design. The correct action after any outage is to let them converge and then verify that they did.

```sql
-- Should return rows immediately after recovery, and none a few cycles later.
SELECT status, count(*) FROM research.participant_sessions
 WHERE status = 'SCHEDULED' AND opens_at < now() GROUP BY status;

SELECT count(*) FROM research.participant_sessions
 WHERE status IN ('AVAILABLE','STARTED') AND closes_at < now();
```

Then confirm the heartbeat is fresh again and `consecutive_failures = 0`.

**What will not be recovered:** notifications whose moment passed during the stall. They are at-most-once and the staleness guard will correctly suppress them rather than deliver a burst of late reminders to every participant at once (STRUCTURE.md §9.1, guard 8). This is the system protecting participants, not a second failure. Sessions themselves are unaffected — the window is stored on the row, not in the queue.

**Never** hand-edit `research.participant_sessions` on a live study to "catch up". Session state is research data. If it genuinely must be corrected, record an audit event and a written justification first.

## 5. If the cause was the host idling the worker out

This will recur, and it will be silent every time.

The worker must be always-on (ADR-010). Move it to a tier that does not idle, or — as a stopgap only — add an external uptime check that keeps it warm. Note the incident in the study's operational log: any period without sweepers is a period where session timing may not reflect the protocol, and that is a fact the eventual analysis is entitled to know.

## 6. Related

- `docs/adr/ADR-005-scheduling-guarantee.md` — why sweepers, not the queue, are the guarantee.
- `docs/adr/ADR-010-deployment-platform.md` — the always-on requirement and why.
- `dead-letter-triage.md` — if the queue is also unhappy.
