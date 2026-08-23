# Runbook — after an outage

**Applies to:** the API was down, the worker was down, the database was unreachable, or the host restarted everything.

**The single most important instruction:** the sweepers are self-healing (ADR-005). After an outage the correct first action is almost always to confirm the worker is running and then *let it converge*. Hand-correcting `participant_sessions` is how a recoverable outage becomes permanent data damage.

---

## 1. Establish what was actually down

| Check | Command | Healthy answer |
|---|---|---|
| API alive | `curl -i $API/health` | `200` |
| API dependencies | `curl -i $API/ready` | `200`. Read `checks[]`. |
| Database | the `postgres` check in `/ready` | `ok: true` |
| Job system | the `jobs` check in `/ready` | `ok: true` |
| Sweepers | operations page → Sweepers | fresh, `consecutive_failures: 0` |

Two readings that mean something specific:

- **`ready: true` with the `jobs` check failing.** Deliberate. The API serves participants correctly without the queue; scheduling is up to one sweep interval late (ADR-005). Do not restart the API for this — fix the worker.
- **`pg-boss UNAVAILABLE` in the worker's startup log.** Also deliberate. The worker runs sweepers-only rather than crash-looping, because a crash loop reconciles nothing. Fix the queue; restarting will not clear it.

## 2. Restore service in dependency order

Database → worker → API. Bringing the API up first is harmless but produces a burst of failing readiness checks that will confuse the next person reading the logs.

If the worker will not start, or starts and does not sweep: `sweeper-stall.md`.

## 3. Let the sweepers converge, then verify they did

Wait two sweep intervals. Then:

```sql
-- Sessions that should have opened while the platform was down.
SELECT count(*) FROM research.participant_sessions
 WHERE status = 'SCHEDULED' AND opens_at < now();

-- Sessions that should have closed.
SELECT count(*) FROM research.participant_sessions
 WHERE status IN ('AVAILABLE','STARTED') AND closes_at < now();
```

Both should be `0`. If either stays non-zero across several cycles, the sweeper is running but not doing its job — `sweeper-stall.md`, and treat it as `SWEEPER_FAILING` even if no alert fired.

## 4. Understand what was lost, and say so

**Sessions: nothing.** Windows live on the row, not in the queue. A session whose window opened during the outage still opened — late, but with the correct `opens_at`, so the timing data is intact.

**Notifications: some, permanently.** Reminders whose moment passed are suppressed by the staleness guard rather than delivered in a burst (STRUCTURE.md §9.1, guard 8). This is correct — a wave of hours-late reminders pulling every participant to closed sessions at once would be worse than silence — but it means participants were genuinely not nudged.

```sql
SELECT suppression_reason, count(*)
  FROM research.notification_attempts
 WHERE scheduled_for > now() - interval '24 hours'
   AND outcome = 'SUPPRESSED'
 GROUP BY suppression_reason;
```

A spike in `SUPPRESSED_STALE` is the measure of the outage in participant terms.

**Tell the researcher, with the window and the count.** A compliance dip in that period has an operational cause, and an analysis that does not know it will read it as disengagement. This is not an optional courtesy; it is a fact about how the data were produced.

## 5. Do not

- Do not re-enqueue missed notifications. At-most-once is deliberate, and a late reminder is worse than none.
- Do not edit session rows to "make up" a missed window. Session state is research data. If a correction is genuinely required, record an audit event and a written justification first.
- Do not extend windows retroactively without the researcher's explicit decision — it silently changes the protocol the study is reporting.

## 6. Related

- `sweeper-stall.md` · `dead-letter-triage.md` · `push-failure-triage.md`
- `docs/adr/ADR-005-scheduling-guarantee.md`
