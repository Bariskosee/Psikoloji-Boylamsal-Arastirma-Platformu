# ADR-004 — Background Job System

**Status:** Accepted
**Date:** 2026-08-17
**Reverses:** the "Redis + Celery or Redis + BullMQ" proposal in earlier project documentation.

## Context

The platform must schedule work days or weeks into the future: activate a questionnaire at a participant-relative time, expire it when its window closes, send an initial notification, and send reminders until completion or a cap.

Earlier documentation proposed Redis with either Celery or BullMQ, and the deployment sketch assumed managed Redis as a required component. That proposal was made before the volume and the atomicity requirements were analysed.

## Decision

**pg-boss, running on the same PostgreSQL database. No Redis.**

## Rationale

**Transactional enqueue is the deciding factor.** `pg-boss.send()` participates in the same transaction as the domain write. When a participant completes a questionnaire, the state change, the newly materialised follow-up sessions, and their activation jobs commit atomically or not at all.

With an external queue there is always a window in which the database says "completed" but the queue never received the follow-up job. The participant's next questionnaire silently never appears, and nothing in the system reports an error. That is precisely the class of silent data-loss failure `AGENT.md` prohibits.

**The volume does not justify Redis.** Several hundred participants, a handful of sessions per day each, a few reminders per session — thousands of jobs per day. BullMQ's advantage is tens of thousands per second. Adopting Redis would mean taking on an additional stateful service, its backup story, its failure modes, and its cost, for throughput headroom we will never approach.

**One backup covers everything.** Job state and research state restore to the same point in time. With a separate Redis, a database restore and a Redis restore diverge, leaving orphaned or duplicated jobs — a recovery problem with no clean answer.

**Fewer moving parts** suits a small team and a single-region EU deployment (ADR-010).

## Alternatives considered

**BullMQ with Redis.** Throughput we do not need, atomicity we do need, an extra stateful service. Rejected.

**Celery with Redis.** Would additionally require the Python backend rejected in ADR-002. Rejected.

**Cron-only polling with no queue.** Simple and robust, but a one-minute poll for every notification gives poor timing granularity and does wasteful work. Rejected as the *primary* mechanism — but adopted as the *backstop*, which is ADR-005.

**Managed queues (SQS, QStash).** Cross-provider dependency, no transactional enqueue, and awkward local development. Rejected.

## Consequences

- The database carries the job load in addition to the query load. At this scale that is negligible; if it ever is not, the first remedy is an index, not Redis.
- pg-boss creates and owns its own `pgboss` schema. It is treated as infrastructure, not as domain data.
- **pg-boss is not the source of truth.** Domain tables are. See ADR-005 — that constraint is what makes this choice safe.
- Jobs use `singletonKey` so duplicates are collapsed, and retries use exponential backoff with a limit of 5. Exhausted jobs land in the dead-letter queue and surface on the operations page.
- Should throughput requirements change by two orders of magnitude, migrating to BullMQ is contained: handlers already assume at-least-once delivery and re-derive all decisions from the database.

## Implementation notes

*Added when the queue was built. The decision above is unchanged; these are the
things the implementation had to get right for it to hold.*

The queue lives in `packages/db/src/jobs/`. It sits there rather than in either
application because `apps/api` enqueues, `apps/worker` enqueues and consumes, and
the two must not import each other (`STRUCTURE.md` §3) — and because the queue is,
in the end, another schema in the same database.

**Transactional enqueue** is `withJobTransaction`. It checks out one client,
opens the transaction, builds Drizzle over that same client, and hands pg-boss a
handle that executes its insert on it. Building Drizzle over the pool instead
would look identical and commit the domain write independently of the job.

**Two pg-boss behaviours are load-bearing and neither is obvious.**

1. A job is inserted by joining the queue registry, so sending to a queue that
   does not exist inserts nothing and returns `null` — no error is raised. The
   wrapper therefore treats a `null` job id as a failure unless the queue is one
   that deduplicates, where `null` is the expected "collapsed into the job
   already queued".

2. `singletonKey` only collapses duplicates on a queue whose policy indexes it.
   On the default `standard` policy the key is accepted, stored, and ignored.
   Job definitions therefore declare *how* duplicates are collapsed
   (`while-queued`, `while-running`, `per-state`), the queue policy is derived
   from that, and a send that supplies a key the policy would ignore — or omits
   one the policy needs — is rejected rather than silently misbehaving.

**Roles.** The worker owns the schema: it migrates, supervises, and is the only
process permitted to consume. The API attaches as a client and refuses to boot if
the schema is absent, so a misconfigured deployment fails at startup rather than
at the first participant completion.

Handlers and sweepers are not implemented yet. They arrive in Phase 7 against the
contract in ADR-005.
