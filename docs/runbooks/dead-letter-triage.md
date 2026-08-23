# Runbook — dead-lettered jobs

**Alert code:** `DEAD_LETTERS`
**Severity:** warning — attend to it today, do not wake anyone tonight.

**Why only a warning.** ADR-005: the queue makes the schedule *prompt*, the sweepers make it *correct*. A dead `session.*` job is re-done by the next sweep with no intervention at all. The exception is `notification.send`, which is deliberately at-most-once (`retryLimit: 0`) and is **not** retried by anything — a dead notification job is a reminder that was not sent and will not be.

So the triage question is never "how do I replay these?" It is: **which of these were notifications, and does the study need to know?**

---

## 1. What is in there

Operations page → **Dead letters**, or:

```sql
SELECT name, count(*), min(created_on) AS oldest, max(created_on) AS newest
  FROM pgboss.job
 WHERE name LIKE '%.dlq'
 GROUP BY name ORDER BY count(*) DESC;
```

> The operations page shows counts and timestamps only, never payloads. A `notification.send` payload names a participant session; a dead-letter listing on a screen left open in a shared office is a privacy incident (AGENT.md §5). Query payloads from a terminal, deliberately, and do not paste them into a ticket.

## 2. Find out *why* they died

```sql
SELECT id, name, created_on, output
  FROM pgboss.job
 WHERE name = 'notification.send.dlq'
 ORDER BY created_on DESC LIMIT 5;
```

`output` carries the failure. The four causes seen in practice:

| Symptom in `output` | Cause | Action |
|---|---|---|
| Database connection / timeout | The database was unreachable when the handler ran | None. Also check `sweeper-stall.md`; this is usually a symptom of the same incident. |
| Payload validation failure | A deploy changed a payload shape while jobs were in flight | Discard. The sweeper enqueues the new shape. See §4. |
| VAPID / 401 / 403 from the push service | Credentials wrong or rotated | `push-failure-triage.md`. Discard these; the subscriptions are the problem, not the jobs. |
| Handler exception in application code | A genuine bug | Fix it, then §4. Keep one payload for the regression test — with the participant identifiers replaced. |

## 3. Decide what it cost

For `notification.send`, translate jobs into participants:

```sql
SELECT count(DISTINCT (data->>'sessionId')) AS sessions_affected,
       min(created_on), max(created_on)
  FROM pgboss.job
 WHERE name = 'notification.send.dlq';
```

If the count is material for the study — more than a handful of participants, or a whole scheduled wave — tell the researcher. They may want it in the study's operational log, because a missing reminder is a plausible explanation for a compliance dip and an analysis that does not know about it will attribute the dip to the participants.

**Do not** re-enqueue them by hand to "make it up". A reminder delivered hours after its window is worse than none: it pulls the participant to a session that has closed, and it contaminates the timing data the study exists to collect.

## 4. Replay — only for `session.*`, only after the cause is fixed

Notification jobs are never replayed. For session work, the correct replay is *no replay*: let the sweeper find it.

```sql
-- Confirm the sweeper has caught up before discarding anything.
SELECT count(*) FROM research.participant_sessions
 WHERE status = 'SCHEDULED' AND opens_at < now();
```

Once that is `0`, the dead letters are redundant history.

## 5. Clear the queue

Only after §2–§4. Deleting first destroys the diagnosis.

```sql
DELETE FROM pgboss.job WHERE name LIKE '%.dlq' AND created_on < now() - interval '7 days';
```

Record what you deleted and why. The alert clears on the next operations-page load.

## 6. Related

- `docs/adr/ADR-004-background-jobs.md` — why pg-boss, and the client/owner split.
- `docs/adr/ADR-005-scheduling-guarantee.md` — why a dead job is usually harmless.
- `packages/db/src/jobs/definitions.ts` — the delivery policy for each job, with reasoning.
