CREATE TABLE "research"."participant_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"participant_id" uuid NOT NULL,
	"study_id" uuid NOT NULL,
	"protocol_version_id" uuid NOT NULL,
	"protocol_step_id" uuid NOT NULL,
	"occurrence_index" integer DEFAULT 0 NOT NULL,
	"questionnaire_version_id" uuid NOT NULL,
	"status" text DEFAULT 'SCHEDULED' NOT NULL,
	"trigger_fired_at" timestamp with time zone,
	"scheduled_at" timestamp with time zone,
	"available_from" timestamp with time zone,
	"available_until" timestamp with time zone,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"expired_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"cancellation_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "participant_sessions_status_valid" CHECK ("research"."participant_sessions"."status" IN ('PENDING_TRIGGER', 'SCHEDULED', 'AVAILABLE', 'STARTED',
                              'COMPLETED', 'EXPIRED_UNSTARTED', 'EXPIRED_PARTIAL', 'CANCELLED')),
	CONSTRAINT "participant_sessions_cancellation_reason_valid" CHECK ("research"."participant_sessions"."cancellation_reason" IS NULL
          OR "research"."participant_sessions"."cancellation_reason" IN ('WITHDRAWAL', 'STUDY_CLOSED', 'TRIGGER_UNREACHABLE', 'ENROLLED_AFTER_WINDOW')),
	CONSTRAINT "participant_sessions_cancellation_complete" CHECK (("research"."participant_sessions"."status" = 'CANCELLED') = ("research"."participant_sessions"."cancelled_at" IS NOT NULL AND "research"."participant_sessions"."cancellation_reason" IS NOT NULL)),
	CONSTRAINT "participant_sessions_completion_complete" CHECK (("research"."participant_sessions"."status" = 'COMPLETED') = ("research"."participant_sessions"."completed_at" IS NOT NULL)),
	CONSTRAINT "participant_sessions_occurrence_nonnegative" CHECK ("research"."participant_sessions"."occurrence_index" >= 0),
	CONSTRAINT "participant_sessions_window_ordered" CHECK ("research"."participant_sessions"."available_from" IS NULL OR "research"."participant_sessions"."available_until" IS NULL
          OR "research"."participant_sessions"."available_until" > "research"."participant_sessions"."available_from")
);
--> statement-breakpoint
CREATE TABLE "research"."response_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"question_version_id" uuid NOT NULL,
	"client_revision" integer NOT NULL,
	"outcome" text NOT NULL,
	"submitted" jsonb NOT NULL,
	"received_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "response_history_outcome_valid" CHECK ("research"."response_history"."outcome" IN ('APPLY', 'IGNORE_STALE', 'IGNORE_DUPLICATE', 'REJECTED'))
);
--> statement-breakpoint
CREATE TABLE "research"."response_option_selections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"response_id" uuid NOT NULL,
	"question_option_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "research"."responses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"participant_id" uuid NOT NULL,
	"question_version_id" uuid NOT NULL,
	"value_kind" text NOT NULL,
	"value_number" double precision,
	"value_text" text,
	"value_boolean" boolean,
	"answered_at" timestamp with time zone NOT NULL,
	"client_revision" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "responses_value_kind_valid" CHECK ("research"."responses"."value_kind" IN ('NUMBER', 'TEXT', 'OPTION', 'BOOLEAN')),
	CONSTRAINT "responses_client_revision_nonnegative" CHECK ("research"."responses"."client_revision" >= 0)
);
--> statement-breakpoint
CREATE TABLE "research"."session_submissions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"completed_at" timestamp with time zone NOT NULL,
	"answered_count" integer NOT NULL,
	"required_count" integer NOT NULL,
	"content_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "session_submissions_counts_nonnegative" CHECK ("research"."session_submissions"."answered_count" >= 0 AND "research"."session_submissions"."required_count" >= 0)
);
--> statement-breakpoint
ALTER TABLE "research"."participant_sessions" ADD CONSTRAINT "participant_sessions_participant_id_participants_id_fk" FOREIGN KEY ("participant_id") REFERENCES "research"."participants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research"."participant_sessions" ADD CONSTRAINT "participant_sessions_study_id_studies_id_fk" FOREIGN KEY ("study_id") REFERENCES "research"."studies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research"."participant_sessions" ADD CONSTRAINT "participant_sessions_protocol_version_id_protocol_versions_id_fk" FOREIGN KEY ("protocol_version_id") REFERENCES "research"."protocol_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research"."participant_sessions" ADD CONSTRAINT "participant_sessions_protocol_step_id_protocol_steps_id_fk" FOREIGN KEY ("protocol_step_id") REFERENCES "research"."protocol_steps"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research"."participant_sessions" ADD CONSTRAINT "participant_sessions_questionnaire_version_id_questionnaire_versions_id_fk" FOREIGN KEY ("questionnaire_version_id") REFERENCES "research"."questionnaire_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research"."response_history" ADD CONSTRAINT "response_history_session_id_participant_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "research"."participant_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research"."response_history" ADD CONSTRAINT "response_history_question_version_id_question_versions_id_fk" FOREIGN KEY ("question_version_id") REFERENCES "research"."question_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research"."response_option_selections" ADD CONSTRAINT "response_option_selections_response_id_responses_id_fk" FOREIGN KEY ("response_id") REFERENCES "research"."responses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research"."response_option_selections" ADD CONSTRAINT "response_option_selections_question_option_id_question_options_id_fk" FOREIGN KEY ("question_option_id") REFERENCES "research"."question_options"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research"."responses" ADD CONSTRAINT "responses_session_id_participant_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "research"."participant_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research"."responses" ADD CONSTRAINT "responses_participant_id_participants_id_fk" FOREIGN KEY ("participant_id") REFERENCES "research"."participants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research"."responses" ADD CONSTRAINT "responses_question_version_id_question_versions_id_fk" FOREIGN KEY ("question_version_id") REFERENCES "research"."question_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research"."session_submissions" ADD CONSTRAINT "session_submissions_session_id_participant_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "research"."participant_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "participant_sessions_occurrence_idx" ON "research"."participant_sessions" USING btree ("participant_id","protocol_step_id","occurrence_index");--> statement-breakpoint
CREATE INDEX "participant_sessions_participant_idx" ON "research"."participant_sessions" USING btree ("participant_id","status");--> statement-breakpoint
CREATE INDEX "participant_sessions_study_idx" ON "research"."participant_sessions" USING btree ("study_id");--> statement-breakpoint
CREATE INDEX "participant_sessions_activation_idx" ON "research"."participant_sessions" USING btree ("available_from") WHERE "research"."participant_sessions"."status" = 'SCHEDULED';--> statement-breakpoint
CREATE INDEX "participant_sessions_expiry_idx" ON "research"."participant_sessions" USING btree ("available_until") WHERE "research"."participant_sessions"."status" IN ('AVAILABLE', 'STARTED');--> statement-breakpoint
CREATE INDEX "response_history_session_idx" ON "research"."response_history" USING btree ("session_id","received_at");--> statement-breakpoint
CREATE UNIQUE INDEX "response_option_selections_idx" ON "research"."response_option_selections" USING btree ("response_id","question_option_id");--> statement-breakpoint
CREATE INDEX "response_option_selections_option_idx" ON "research"."response_option_selections" USING btree ("question_option_id");--> statement-breakpoint
CREATE UNIQUE INDEX "responses_session_question_idx" ON "research"."responses" USING btree ("session_id","question_version_id");--> statement-breakpoint
CREATE INDEX "responses_participant_idx" ON "research"."responses" USING btree ("participant_id");--> statement-breakpoint
CREATE INDEX "responses_session_idx" ON "research"."responses" USING btree ("session_id");--> statement-breakpoint
CREATE UNIQUE INDEX "session_submissions_session_idx" ON "research"."session_submissions" USING btree ("session_id");--> statement-breakpoint

-- ─────────────────────────────────────────────────────────────────────────────
-- Responses under a COMPLETED session are immutable.
--
-- Completion is the moment a measurement becomes data. Editing an answer
-- afterwards would change a value that has already been counted, exported, and
-- possibly analysed, with nothing in the row to say it happened.
--
-- Enforced by a trigger rather than by the service for the same reason as every
-- other immutability rule here: "the application always checks" is a property
-- nobody can verify, while a BEFORE trigger holds for psql and for a future
-- service too.
--
-- Note what is NOT forbidden: writes to an EXPIRED session. Those are refused
-- by the window check in the service, which returns a typed error a participant
-- can act on. A trigger there would surface as an opaque 500 instead.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION research.forbid_completed_session_response_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
  session_status text;
BEGIN
  SELECT status INTO session_status
  FROM research.participant_sessions
  WHERE id = COALESCE(NEW.session_id, OLD.session_id);

  IF session_status = 'COMPLETED' THEN
    RAISE EXCEPTION 'responses under a completed session are immutable; % is not permitted', TG_OP
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER responses_completed_immutable
  BEFORE INSERT OR UPDATE OR DELETE ON "research"."responses"
  FOR EACH ROW EXECUTE FUNCTION research.forbid_completed_session_response_mutation();
--> statement-breakpoint

-- The selections belong to the response, so they inherit its session's status.
CREATE OR REPLACE FUNCTION research.forbid_completed_session_selection_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
  session_status text;
BEGIN
  SELECT s.status INTO session_status
  FROM research.responses r
  JOIN research.participant_sessions s ON s.id = r.session_id
  WHERE r.id = COALESCE(NEW.response_id, OLD.response_id);

  IF session_status = 'COMPLETED' THEN
    RAISE EXCEPTION 'selections under a completed session are immutable; % is not permitted', TG_OP
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER response_option_selections_completed_immutable
  BEFORE INSERT OR UPDATE OR DELETE ON "research"."response_option_selections"
  FOR EACH ROW EXECUTE FUNCTION research.forbid_completed_session_selection_mutation();
--> statement-breakpoint

-- ─────────────────────────────────────────────────────────────────────────────
-- `response_history` is append-only.
--
-- It exists to answer "what did the client send and what did we do with it",
-- including the writes that were ignored. A history that can be edited answers
-- nothing — it would agree with the current state by construction.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION research.forbid_response_history_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  RAISE EXCEPTION 'response_history is append-only; % is not permitted', TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER response_history_append_only
  BEFORE UPDATE OR DELETE ON "research"."response_history"
  FOR EACH ROW EXECUTE FUNCTION research.forbid_response_history_mutation();
--> statement-breakpoint

-- A submission records a completion that happened. It is never revised.
CREATE OR REPLACE FUNCTION research.forbid_session_submission_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  RAISE EXCEPTION 'a session submission is immutable; % is not permitted', TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER session_submissions_immutable
  BEFORE UPDATE OR DELETE ON "research"."session_submissions"
  FOR EACH ROW EXECUTE FUNCTION research.forbid_session_submission_mutation();
--> statement-breakpoint

CREATE TRIGGER participant_sessions_set_updated_at
  BEFORE UPDATE ON "research"."participant_sessions"
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint
CREATE TRIGGER responses_set_updated_at
  BEFORE UPDATE ON "research"."responses"
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
