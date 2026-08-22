/**
 * Background jobs (ADR-004) — pg-boss on the same PostgreSQL database.
 *
 * `apps/api` enqueues, `apps/worker` enqueues and consumes. They share this
 * module rather than each other (STRUCTURE.md §3), which is what keeps the
 * definition of a job identical on both sides of the queue.
 *
 * Handlers and sweepers are not here. They live in `apps/worker` and arrive
 * with the scheduling engine in Phase 7, against the contract in ADR-005.
 */
export * from "./job-definition.js";
export * from "./queue.js";
export * from "./transaction.js";
export * from "./definitions.js";
