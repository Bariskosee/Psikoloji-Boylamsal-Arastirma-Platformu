-- ADR-005 — reconciliation sweepers are authoritative; jobs are an optimisation.
--
-- One table: `research.system_heartbeats`, the evidence that the sweep loop is
-- running. See the Drizzle definition for why the loop needs its own evidence
-- and why the two failure signals are recorded separately.
--
-- Additive and backward-compatible: nothing existing is altered, so the
-- previous release runs unchanged against this schema and a rollback strands
-- nothing (STRUCTURE.md §17).
--
-- No GRANT statements are needed. Migration 0000 set ALTER DEFAULT PRIVILEGES
-- on both schemas precisely so later migrations do not have to remember; the
-- integration test asserts the privileges actually landed rather than assuming
-- they did.

CREATE TABLE "research"."system_heartbeats" (
	"worker_id" text PRIMARY KEY NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"swept_at" timestamp with time zone NOT NULL,
	"sweep_interval_seconds" integer NOT NULL,
	"consecutive_failures" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	CONSTRAINT "system_heartbeats_sweep_interval_positive" CHECK ("research"."system_heartbeats"."sweep_interval_seconds" > 0),
	CONSTRAINT "system_heartbeats_consecutive_failures_nonnegative" CHECK ("research"."system_heartbeats"."consecutive_failures" >= 0)
);
