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
