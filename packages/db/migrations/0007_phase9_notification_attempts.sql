-- ─────────────────────────────────────────────────────────────────────────────
-- Phase 9 — the notification and reminder engine (PLAN.md, STRUCTURE.md §9).
--
-- One table, and its unique index is the point: (session_id, kind,
-- occurrence_index) is THE duplicate-reminder guard. Job delivery is
-- at-least-once, two workers may claim the same job, and the notifications-due
-- sweeper may find work a job is already doing. The handler checks first
-- because it is cheap; this index is what makes the guarantee true, because an
-- application check loses the race and a constraint does not.
--
-- `push_subscription_id` carries NO foreign key. The subscription lives in the
-- `identity` schema, and a cross-schema constraint would reintroduce the
-- coupling that separation exists to prevent (ADR-003). It also makes Phase 8's
-- prune sweeper safe: deleting a dead endpoint leaves the attempt intact, which
-- is right — the attempt is research evidence, the endpoint was only the means.
--
-- No GRANTs needed: migration 0000 set ALTER DEFAULT PRIVILEGES on `research`,
-- so `app_readwrite` gets CRUD and `app_analytics` gets SELECT. Analytics
-- SHOULD read this table — it is how outreach is compared against completion.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE "research"."notification_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"participant_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"occurrence_index" integer NOT NULL,
	"push_subscription_id" uuid,
	"scheduled_for" timestamp with time zone NOT NULL,
	"attempted_at" timestamp with time zone,
	"outcome" text NOT NULL,
	"suppression_reason" text,
	"push_status_code" integer,
	"error_detail" text,
	"displayed_at" timestamp with time zone,
	"clicked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notification_attempts_kind_valid" CHECK ("research"."notification_attempts"."kind" IN ('INITIAL', 'REMINDER')),
	CONSTRAINT "notification_attempts_outcome_valid" CHECK ("research"."notification_attempts"."outcome" IN ('ATTEMPTED', 'SENT_ACCEPTED', 'FAILED', 'SUPPRESSED')),
	CONSTRAINT "notification_attempts_occurrence_nonnegative" CHECK ("research"."notification_attempts"."occurrence_index" >= 0),
	CONSTRAINT "notification_attempts_suppression_complete" CHECK (("research"."notification_attempts"."outcome" = 'SUPPRESSED' AND "research"."notification_attempts"."suppression_reason" IS NOT NULL)
          OR ("research"."notification_attempts"."outcome" <> 'SUPPRESSED' AND "research"."notification_attempts"."suppression_reason" IS NULL)),
	CONSTRAINT "notification_attempts_suppression_reason_valid" CHECK ("research"."notification_attempts"."suppression_reason" IS NULL OR "research"."notification_attempts"."suppression_reason" IN (
            'SUPPRESSED_STATE', 'SUPPRESSED_EXPIRED', 'SUPPRESSED_WITHDRAWN',
            'SUPPRESSED_CAP', 'SUPPRESSED_NO_SUBSCRIPTION', 'SUPPRESSED_QUIET_HOURS',
            'SUPPRESSED_STALE')),
	CONSTRAINT "notification_attempts_attempted_at_consistent" CHECK (("research"."notification_attempts"."outcome" = 'SUPPRESSED' AND "research"."notification_attempts"."attempted_at" IS NULL)
          OR ("research"."notification_attempts"."outcome" <> 'SUPPRESSED' AND "research"."notification_attempts"."attempted_at" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "research"."notification_attempts" ADD CONSTRAINT "notification_attempts_session_id_participant_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "research"."participant_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research"."notification_attempts" ADD CONSTRAINT "notification_attempts_participant_id_participants_id_fk" FOREIGN KEY ("participant_id") REFERENCES "research"."participants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "notification_attempts_unique_idx" ON "research"."notification_attempts" USING btree ("session_id","kind","occurrence_index");--> statement-breakpoint
CREATE INDEX "notification_attempts_participant_idx" ON "research"."notification_attempts" USING btree ("participant_id","scheduled_for");--> statement-breakpoint
CREATE INDEX "notification_attempts_session_idx" ON "research"."notification_attempts" USING btree ("session_id");
--> statement-breakpoint

-- updated_at maintenance, as on every other table.
CREATE TRIGGER notification_attempts_set_updated_at
  BEFORE UPDATE ON "research"."notification_attempts"
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
