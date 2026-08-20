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

## Implementation notes

*Added when the reconciliation loop was built. The decision above is unchanged;
these are the things the implementation had to get right for it to hold.*

The loop lives in `apps/worker/src/sweepers/`. It runs on the worker's own
connection pool and does not touch pg-boss: a queue that cannot connect must not
be able to stop the mechanism that exists to survive the queue failing.

**What runs today.** `sweep.heartbeat`, writing `research.system_heartbeats`.
The three session sweepers are not registered, because `participant_sessions`
and `notification_attempts` do not exist yet — they arrive with the protocol and
runtime phases. Each is a `Sweeper` supplying four functions to `reconcile()`;
registering one is adding it to the array in `sweepers/index.ts`. The loop, the
cross-replica exclusion, the batching, the per-row locking and the heartbeat are
built and tested against real PostgreSQL, so those phases write queries rather
than machinery.

**The handler contract is code, not prose.** `reconcile()` takes `claim`,
`lock`, `decide` and `apply`, and there is no way to express a handler that
skips the lock or judges stale data: `decide` receives the freshly locked row
and nothing else. Rules stated only in a document get followed until the day
someone is in a hurry.

**The claim and the work are separate transactions.** `FOR UPDATE SKIP LOCKED`
holds its locks until the transaction ends, so claiming 500 rows and processing
them inside that transaction would block every participant whose session was in
the batch — a `POST /complete` would wait on a sweeper. The claim therefore
commits immediately and the locks drop, which leaves a window in which those
rows may change. That window is not a defect to close; it is why step 2 of the
contract exists. Correctness never depends on the claim being exclusive, and
that is what makes the design safe under duplicate delivery, concurrent
replicas, and a restored backup.

**Cross-replica exclusion is a PostgreSQL advisory lock**, not the job
`singletonKey` §8.4 originally described. Three reasons: a singleton key
collapses duplicate *enqueues* while an advisory lock excludes overlapping
*execution*, which is the property actually wanted; cron's one-minute
granularity cannot express a configurable `SWEEP_INTERVAL_SECONDS`; and an
advisory lock is released by the database when the session ends, however it
ends, so a worker killed mid-sweep leaves nothing behind. A lock *row* would
survive, and the next worker could not distinguish it from a sweep still
legitimately in progress — reintroducing exactly the failure mode this ADR
exists to eliminate. The lock is an efficiency measure regardless: with it
removed entirely, replicas would duplicate work and still produce correct
results.

**The heartbeat records two signals, not one.** A worker whose sweepers all
throw still completes its cycles, so a liveness-only heartbeat would stay fresh
while nothing was being reconciled. `swept_at` going stale means the loop
stopped; `consecutive_failures` rising means the loop runs and the work inside
it fails. They need different responses, so they are stored separately. Every
timestamp comes from the database's `now()` — the same clock the sweep queries
compare `available_from` against — because a worker with a skewed clock must not
be able to vouch for itself.

**The staleness guard is a pure function** in `packages/domain/src/scheduling/`,
with an injected clock. Applied to a reminder chain with an hourly interval, an
outage backlog collapses to the single most recent notification: the participant
gets one nudge, and the rest are recorded as suppressed rather than sent late or
silently dropped.

**Every sweep transaction bounds how long it will wait for a lock**
(`lock_timeout`, five seconds). `lock()` blocks on purpose — waiting for a
participant's completion is how the sweeper comes to see it and correctly
declines to act — but "blocking" has no upper bound. One session left idle in a
transaction, or a migration holding `ACCESS EXCLUSIVE`, would park the sweep
inside the driver indefinitely; the abort signal cannot reach it, because the
process is waiting on the database rather than on JavaScript. Every later cycle
would queue behind it while the worker still reported itself alive. Timing out
costs one row one cycle; not timing out costs the guarantee. The heartbeat write
is bounded for the same reason, and more sharply: a heartbeat that hung would
leave the loop both stopped and unable to report that it stopped.

**A queue that will not start does not take the sweepers down with it.** Letting
`boss.start()` throw would exit the process, the platform would restart it, and
it would fail again — a crash loop in which nothing ever reconciles, which is
operationally identical to the idle-spin-down tier ADR-010 warns about. So the
failure is logged, reported, and survived: the worker runs with sweepers only.
This follows directly from the decision above. Jobs make the system prompt;
sweepers make it correct. A worker with a broken queue is degraded — every
activation, expiry and reminder is up to one interval late — not useless, and
staying up while loudly broken strictly dominates restarting quietly forever.

**Recovery is tested, and the tests are the gating ones.** Against real
PostgreSQL: two sweeps running concurrently activate every row exactly once; a
completion landing between the claim and the lock makes the sweeper wait and
then decline; a row that fails permanently does not stall the rows behind it; a
backlog larger than the batch limit converges over successive cycles; and a row
wedged by an abandoned transaction is abandoned after the lock timeout instead of
hanging the loop. `SKIP LOCKED`, blocking row locks and per-row transaction
isolation have no faithful in-memory equivalent, so none of this is tested
against a fake.

The worker was also run end to end against a database whose role cannot create
the `pgboss` schema: it logged the queue failure, kept sweeping, and wrote
heartbeats throughout.
