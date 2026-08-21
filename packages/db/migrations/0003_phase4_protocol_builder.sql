CREATE TABLE "research"."protocols" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"study_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "research"."protocol_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"protocol_id" uuid NOT NULL,
	"status" text DEFAULT 'DRAFT' NOT NULL,
	"version_number" integer,
	"published_at" timestamp with time zone,
	"published_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "protocol_versions_status_valid" CHECK ("research"."protocol_versions"."status" IN ('DRAFT', 'PUBLISHED', 'RETIRED')),
	CONSTRAINT "protocol_versions_publication_complete" CHECK (("research"."protocol_versions"."status" = 'DRAFT' AND "research"."protocol_versions"."version_number" IS NULL AND "research"."protocol_versions"."published_at" IS NULL)
          OR ("research"."protocol_versions"."status" <> 'DRAFT' AND "research"."protocol_versions"."version_number" IS NOT NULL AND "research"."protocol_versions"."published_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "research"."reminder_policies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"initial_delay_iso" text NOT NULL,
	"interval_iso" text NOT NULL,
	"max_reminders" integer NOT NULL,
	"quiet_hours_start" text,
	"quiet_hours_end" text,
	"quiet_hours_behavior" text DEFAULT 'DEFER' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reminder_policies_max_nonnegative" CHECK ("research"."reminder_policies"."max_reminders" >= 0),
	CONSTRAINT "reminder_policies_quiet_hours_behavior_valid" CHECK ("research"."reminder_policies"."quiet_hours_behavior" IN ('SKIP', 'DEFER')),
	CONSTRAINT "reminder_policies_quiet_hours_paired" CHECK (("research"."reminder_policies"."quiet_hours_start" IS NULL) = ("research"."reminder_policies"."quiet_hours_end" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "research"."protocol_steps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"protocol_version_id" uuid NOT NULL,
	"step_index" integer NOT NULL,
	"step_key" text NOT NULL,
	"questionnaire_version_id" uuid NOT NULL,
	"step_kind" text DEFAULT 'SCHEDULED' NOT NULL,
	"trigger_type" text NOT NULL,
	"trigger_step_id" uuid,
	"trigger_occurrence_index" integer,
	"trigger_fixed_date" date,
	"offset_iso" text DEFAULT 'PT0S' NOT NULL,
	"anchor_local_time" text,
	"anchor_timezone_source" text,
	"window_duration_iso" text NOT NULL,
	"occurrence_count" integer DEFAULT 1 NOT NULL,
	"recurrence_interval_iso" text,
	"reminder_policy_id" uuid,
	"counts_toward_compliance" boolean DEFAULT true NOT NULL,
	"min_interval_iso" text,
	"max_per_day" integer,
	"max_total" integer,
	"allowed_group_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "protocol_steps_trigger_type_valid" CHECK ("research"."protocol_steps"."trigger_type" IN ('ENROLLMENT', 'CONSENT', 'STEP_COMPLETED', 'STEP_AVAILABLE', 'FIXED_DATETIME')),
	CONSTRAINT "protocol_steps_kind_valid" CHECK ("research"."protocol_steps"."step_kind" IN ('SCHEDULED', 'PARTICIPANT_INITIATED')),
	CONSTRAINT "protocol_steps_anchor_source_valid" CHECK ("research"."protocol_steps"."anchor_timezone_source" IS NULL OR "research"."protocol_steps"."anchor_timezone_source" IN ('STUDY', 'PARTICIPANT')),
	CONSTRAINT "protocol_steps_trigger_reference_matches_type" CHECK (("research"."protocol_steps"."trigger_type" IN ('STEP_COMPLETED', 'STEP_AVAILABLE')) = ("research"."protocol_steps"."trigger_step_id" IS NOT NULL)),
	CONSTRAINT "protocol_steps_fixed_date_matches_type" CHECK (("research"."protocol_steps"."trigger_type" = 'FIXED_DATETIME') = ("research"."protocol_steps"."trigger_fixed_date" IS NOT NULL)),
	CONSTRAINT "protocol_steps_occurrence_index_needs_reference" CHECK ("research"."protocol_steps"."trigger_occurrence_index" IS NULL OR "research"."protocol_steps"."trigger_step_id" IS NOT NULL),
	CONSTRAINT "protocol_steps_occurrence_index_nonnegative" CHECK ("research"."protocol_steps"."trigger_occurrence_index" IS NULL OR "research"."protocol_steps"."trigger_occurrence_index" >= 0),
	CONSTRAINT "protocol_steps_wall_clock_paired" CHECK (("research"."protocol_steps"."anchor_local_time" IS NULL) = ("research"."protocol_steps"."anchor_timezone_source" IS NULL)),
	CONSTRAINT "protocol_steps_occurrence_count_positive" CHECK ("research"."protocol_steps"."occurrence_count" >= 1),
	CONSTRAINT "protocol_steps_recurrence_matches_count" CHECK (("research"."protocol_steps"."occurrence_count" > 1) = ("research"."protocol_steps"."recurrence_interval_iso" IS NOT NULL)),
	CONSTRAINT "protocol_steps_rate_limits_scoped" CHECK ("research"."protocol_steps"."step_kind" = 'PARTICIPANT_INITIATED'
          OR ("research"."protocol_steps"."min_interval_iso" IS NULL AND "research"."protocol_steps"."max_per_day" IS NULL AND "research"."protocol_steps"."max_total" IS NULL)),
	CONSTRAINT "protocol_steps_step_index_nonnegative" CHECK ("research"."protocol_steps"."step_index" >= 0)
);
--> statement-breakpoint
ALTER TABLE "research"."protocols" ADD CONSTRAINT "protocols_study_id_studies_id_fk" FOREIGN KEY ("study_id") REFERENCES "research"."studies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research"."protocols" ADD CONSTRAINT "protocols_created_by_researcher_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "identity"."researcher_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research"."protocol_versions" ADD CONSTRAINT "protocol_versions_protocol_id_protocols_id_fk" FOREIGN KEY ("protocol_id") REFERENCES "research"."protocols"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research"."protocol_versions" ADD CONSTRAINT "protocol_versions_published_by_researcher_users_id_fk" FOREIGN KEY ("published_by") REFERENCES "identity"."researcher_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research"."protocol_steps" ADD CONSTRAINT "protocol_steps_protocol_version_id_protocol_versions_id_fk" FOREIGN KEY ("protocol_version_id") REFERENCES "research"."protocol_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research"."protocol_steps" ADD CONSTRAINT "protocol_steps_questionnaire_version_id_questionnaire_versions_id_fk" FOREIGN KEY ("questionnaire_version_id") REFERENCES "research"."questionnaire_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research"."protocol_steps" ADD CONSTRAINT "protocol_steps_reminder_policy_id_reminder_policies_id_fk" FOREIGN KEY ("reminder_policy_id") REFERENCES "research"."reminder_policies"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "protocols_study_idx" ON "research"."protocols" USING btree ("study_id");--> statement-breakpoint
CREATE UNIQUE INDEX "protocol_versions_one_draft_idx" ON "research"."protocol_versions" USING btree ("protocol_id") WHERE "research"."protocol_versions"."status" = 'DRAFT';--> statement-breakpoint
CREATE UNIQUE INDEX "protocol_versions_number_idx" ON "research"."protocol_versions" USING btree ("protocol_id","version_number");--> statement-breakpoint
CREATE INDEX "protocol_steps_version_idx" ON "research"."protocol_steps" USING btree ("protocol_version_id");--> statement-breakpoint
CREATE INDEX "protocol_steps_questionnaire_version_idx" ON "research"."protocol_steps" USING btree ("questionnaire_version_id");--> statement-breakpoint
CREATE UNIQUE INDEX "protocol_steps_key_idx" ON "research"."protocol_steps" USING btree ("protocol_version_id","step_key");--> statement-breakpoint
CREATE UNIQUE INDEX "protocol_steps_order_idx" ON "research"."protocol_steps" USING btree ("protocol_version_id","step_index");--> statement-breakpoint

-- ─────────────────────────────────────────────────────────────────────────────
-- Immutability of published protocol versions (ADR-008, NFR-17).
--
-- The same construction as the questionnaire tables in 0001, and the stakes are
-- higher. An enrollment pins a protocol_version_id for the participant's whole
-- life in the study, so a published version is the schedule a real person is
-- living under. Editing one would silently re-time measurements already taken,
-- and nothing afterwards could say which schedule produced which response.
--
-- Enforced by a trigger rather than by the service, because "the application
-- always goes through the publish path" is a property no one can verify, while
-- a BEFORE UPDATE trigger holds for psql, a migration, and a future service
-- alike.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION research.forbid_published_protocol_version_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  IF OLD.status IN ('PUBLISHED', 'RETIRED') THEN
    RAISE EXCEPTION 'a published protocol version is immutable; % is not permitted', TG_OP
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER protocol_versions_published_immutable
  BEFORE UPDATE OR DELETE ON "research"."protocol_versions"
  FOR EACH ROW EXECUTE FUNCTION research.forbid_published_protocol_version_mutation();
--> statement-breakpoint

-- Steps check their version's status through a subquery rather than carrying a
-- duplicated status column that every write path would have to keep in sync.
CREATE OR REPLACE FUNCTION research.forbid_published_protocol_step_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
  parent_status text;
BEGIN
  SELECT status INTO parent_status
  FROM research.protocol_versions
  WHERE id = OLD.protocol_version_id;

  IF parent_status IN ('PUBLISHED', 'RETIRED') THEN
    RAISE EXCEPTION 'a step under a published protocol version is immutable; % is not permitted', TG_OP
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER protocol_steps_published_immutable
  BEFORE UPDATE OR DELETE ON "research"."protocol_steps"
  FOR EACH ROW EXECUTE FUNCTION research.forbid_published_protocol_step_mutation();
--> statement-breakpoint

-- A reminder policy is reached only through the step that owns it, so its
-- immutability is that step's version's status.
CREATE OR REPLACE FUNCTION research.forbid_published_reminder_policy_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
  parent_status text;
BEGIN
  SELECT pv.status INTO parent_status
  FROM research.protocol_steps s
  JOIN research.protocol_versions pv ON pv.id = s.protocol_version_id
  WHERE s.reminder_policy_id = OLD.id
  LIMIT 1;

  IF parent_status IN ('PUBLISHED', 'RETIRED') THEN
    RAISE EXCEPTION 'a reminder policy under a published protocol version is immutable; % is not permitted', TG_OP
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER reminder_policies_published_immutable
  BEFORE UPDATE OR DELETE ON "research"."reminder_policies"
  FOR EACH ROW EXECUTE FUNCTION research.forbid_published_reminder_policy_mutation();
--> statement-breakpoint

-- A step's trigger may only name a step in the SAME version. Without this a
-- reference could cross versions and a published protocol would depend on a
-- draft that is still being edited.
ALTER TABLE "research"."protocol_steps"
  ADD CONSTRAINT "protocol_steps_trigger_step_fk"
  FOREIGN KEY ("trigger_step_id") REFERENCES "research"."protocol_steps"("id") ON DELETE RESTRICT;
--> statement-breakpoint

-- The updated_at maintenance the other tables already have.
CREATE TRIGGER protocols_set_updated_at
  BEFORE UPDATE ON "research"."protocols"
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint
CREATE TRIGGER protocol_versions_set_updated_at
  BEFORE UPDATE ON "research"."protocol_versions"
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint
CREATE TRIGGER protocol_steps_set_updated_at
  BEFORE UPDATE ON "research"."protocol_steps"
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint
CREATE TRIGGER reminder_policies_set_updated_at
  BEFORE UPDATE ON "research"."reminder_policies"
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
