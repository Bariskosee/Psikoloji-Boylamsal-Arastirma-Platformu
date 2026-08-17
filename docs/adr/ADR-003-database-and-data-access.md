# ADR-003 — Database, Schema Separation, and Data Access

**Status:** Accepted
**Date:** 2026-08-17

## Context

The platform stores sensitive psychological research data alongside re-identifying data (push endpoints, continuity credentials, optional contact details). NFR-03 requires these to be separated, and the separation must be enforceable rather than a convention that a future query can quietly violate.

The data access layer must also serve two very different workloads: straightforward CRUD for the builders, and aggregate analytical SQL for compliance metrics, response distributions, and wide-format export.

## Decision

**PostgreSQL 16**, one database, **two schemas with two roles**, accessed through **Drizzle ORM** with drizzle-kit migrations.

```text
schema research   studies, questionnaires, protocols, participants (pseudonymous),
                  participant_sessions, responses, notification_attempts, audit_events

schema identity   participant_credentials, push_subscriptions,
                  participant_contacts, recovery_codes

role app_readwrite   CRUD on research, identity, pgboss     → api, worker
role app_analytics   SELECT on research ONLY
                     NO privileges on identity              → analytics, export
```

## Why PostgreSQL

Non-negotiable given the requirements: transactional guarantees for the completion-and-schedule operation, referential integrity across the version graph, `SELECT … FOR UPDATE SKIP LOCKED` for job claiming, partial unique indexes for idempotency, and window functions for compliance and wide-format export. No alternative was seriously considered.

## Why one database with two schemas

A single database keeps the completion-and-schedule write atomic — the state change, the newly materialised sessions, and their jobs commit together or not at all.

Two schemas with two roles give a privacy boundary that the database enforces. **An export query that accidentally joins a push endpoint fails at the database, in CI, before review.** That is the difference between NFR-03 being a requirement and being a hope.

A second physical database was rejected: it would buy marginal isolation while losing cross-schema transactions, a poor trade at a scale of several hundred participants.

## Why Drizzle over Prisma

Compliance metrics, response distributions, and wide-format export are aggregate SQL problems — `FILTER`, `GROUP BY GROUPING SETS`, `LATERAL`, window functions. Drizzle is SQL-shaped and lets those queries be written directly while staying fully typed. Its schema definitions are plain TypeScript that `packages/domain` can import for types without importing a client.

Migrations are generated SQL files, reviewable in a pull request. This matters because `AGENT.md` requires special care for any migration touching response semantics, and a reviewable SQL diff is the only way to exercise that care.

**Prisma** was the main alternative: better CRUD ergonomics and a more mature ecosystem, but it pushes complex analytics into raw queries — losing the type safety that motivated the choice — and its migration engine is less transparent for the hand-written data migrations that version bumps will require.

**Kysely** was a close second and would have been acceptable. Drizzle wins on keeping schema, types, and migrations in one place.

## Consequences

- Every analytics and export code path must connect as `app_analytics`. This must be wired in Phase 1 and verified by a test asserting the role cannot read `identity`.
- Migrations are version-controlled SQL, applied as a pre-deploy step, and always backward-compatible with the previous release so a rollback never strands the schema.
- Response values are stored in typed columns rather than a JSON blob, because they are aggregated on every analytics query. See `STRUCTURE.md` §6.
- Uniqueness for idempotency is enforced by database constraints, not application logic, because application-level checks lose races.
- Developers write more SQL-like code than they would with Prisma. Accepted, given how much of the value of this platform lives in aggregate queries.
