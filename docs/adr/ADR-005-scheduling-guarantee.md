# ADR-005 — Reconciliation Sweepers Are Authoritative; Jobs Are an Optimisation

**Status:** Accepted
**Date:** 2026-08-17

## Context

NFR-14 requires that multi-day scheduling survive process restarts, worker outages, lost jobs, and database restoration from backup — and recover without duplicate side effects.

Any queue-driven design has a failure mode: if a delayed job is lost, nothing ever notices. There is no error, no alert, and no retry, because the system has no independent record that the work was owed. For a longitudinal study, a lost activation means a participant never receives a questionnaire and that measurement point is gone permanently.

## Decision

**The database is the schedule. The queue only executes.**

Every scheduling outcome must be derivable from `participant_sessions` and `notification_attempts` alone. Four reconciliation sweepers run every 60 seconds and are the authoritative mechanism:

```sql
-- sweep.activate_due
SELECT id FROM research.participant_sessions
WHERE status = 'SCHEDULED' AND available_from <= now()
FOR UPDATE SKIP LOCKED LIMIT 500;

-- sweep.expire_due
SELECT id FROM research.participant_sessions
WHERE status IN ('AVAILABLE','STARTED') AND available_until <= now()
FOR UPDATE SKIP LOCKED LIMIT 500;

-- sweep.notifications_due
--   sessions in AVAILABLE/STARTED, window open, active subscription,
--   whose next due notification has no notification_attempts row
FOR UPDATE SKIP LOCKED LIMIT 500;

-- sweep.heartbeat
--   write system_heartbeats(worker_id, swept_at); alert if stale > 5 min
```

Delayed jobs still exist, and they are what makes timing precise between sweeps. But **jobs make the system prompt; sweepers make it correct.**

Every handler, job or sweeper alike, follows the same contract:

1. Open a transaction and take `SELECT … FOR UPDATE` on the session row.
2. Re-read canonical state and re-derive the decision. Never trust the job payload beyond identifiers.
3. No-op when the decision is no longer valid, recording why when research-relevant.
4. Be safe to run twice, out of order, or a week late.

## Consequences

**The system converges on correct state from any starting condition.** Queue wiped, worker down for six hours, database restored from backup, jobs delivered twice — the sweepers restore correct behaviour within 60 seconds, with no manual intervention. This is the property that makes NFR-14 real.

**A dead-lettered job degrades timing, not correctness.** A notification might arrive a minute late; it will not be missed entirely.

**Recovery is testable, and those tests are gating.** Phase 7 cannot be signed off until: deleting every pending job and running the sweepers restores full correctness; a simulated six-hour outage self-heals on restart with no duplicates; and duplicate job delivery produces exactly one effect.

**The worker must be always-on.** A hosting tier that spins down when idle stops the sweepers and silently disables the entire guarantee. This is called out in ADR-010 and in the deployment runbook.

**A staleness guard is required.** After a long outage the sweepers will find many overdue notifications at once. Sending them all would produce a burst at an unpredictable hour. Notifications whose scheduled time is older than one reminder interval are suppressed with a recorded reason rather than sent late.

**Cost:** four queries per minute against indexed columns, plus a heartbeat write. Negligible, and the price of never silently losing a measurement point.
