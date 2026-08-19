CREATE TABLE "research"."questionnaires" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"study_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "research"."questionnaire_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"questionnaire_id" uuid NOT NULL,
	"status" text DEFAULT 'DRAFT' NOT NULL,
	"version_number" integer,
	"published_at" timestamp with time zone,
	"published_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "questionnaire_versions_status_valid" CHECK ("research"."questionnaire_versions"."status" IN ('DRAFT', 'PUBLISHED', 'RETIRED')),
	CONSTRAINT "questionnaire_versions_number_shape" CHECK (("research"."questionnaire_versions"."status" = 'DRAFT') = ("research"."questionnaire_versions"."version_number" IS NULL)),
	CONSTRAINT "questionnaire_versions_published_at_shape" CHECK (("research"."questionnaire_versions"."status" = 'DRAFT') = ("research"."questionnaire_versions"."published_at" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "research"."question_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"questionnaire_version_id" uuid NOT NULL,
	"question_key" text NOT NULL,
	"type" text NOT NULL,
	"is_required" boolean DEFAULT true NOT NULL,
	"page_index" integer DEFAULT 0 NOT NULL,
	"display_order" integer NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "question_versions_type_valid" CHECK ("research"."question_versions"."type" IN ('SINGLE_CHOICE', 'MULTI_CHOICE', 'LIKERT', 'NUMERIC', 'FREE_TEXT')),
	CONSTRAINT "question_versions_page_index_nonnegative" CHECK ("research"."question_versions"."page_index" >= 0),
	CONSTRAINT "question_versions_display_order_nonnegative" CHECK ("research"."question_versions"."display_order" >= 0)
);
--> statement-breakpoint
CREATE TABLE "research"."question_version_translations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"question_version_id" uuid NOT NULL,
	"locale" text NOT NULL,
	"text" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "question_version_translations_locale_valid" CHECK ("research"."question_version_translations"."locale" IN ('en', 'tr'))
);
--> statement-breakpoint
CREATE TABLE "research"."question_options" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"question_version_id" uuid NOT NULL,
	"option_key" text NOT NULL,
	"display_order" integer NOT NULL,
	"value_number" double precision,
	"is_exclusive" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "question_options_display_order_nonnegative" CHECK ("research"."question_options"."display_order" >= 0)
);
--> statement-breakpoint
CREATE TABLE "research"."question_option_translations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"question_option_id" uuid NOT NULL,
	"locale" text NOT NULL,
	"label" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "question_option_translations_locale_valid" CHECK ("research"."question_option_translations"."locale" IN ('en', 'tr'))
);
--> statement-breakpoint
ALTER TABLE "research"."questionnaires" ADD CONSTRAINT "questionnaires_study_id_studies_id_fk" FOREIGN KEY ("study_id") REFERENCES "research"."studies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research"."questionnaires" ADD CONSTRAINT "questionnaires_created_by_researcher_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "identity"."researcher_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research"."questionnaire_versions" ADD CONSTRAINT "questionnaire_versions_questionnaire_id_questionnaires_id_fk" FOREIGN KEY ("questionnaire_id") REFERENCES "research"."questionnaires"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research"."questionnaire_versions" ADD CONSTRAINT "questionnaire_versions_published_by_researcher_users_id_fk" FOREIGN KEY ("published_by") REFERENCES "identity"."researcher_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research"."question_versions" ADD CONSTRAINT "question_versions_questionnaire_version_id_questionnaire_versions_id_fk" FOREIGN KEY ("questionnaire_version_id") REFERENCES "research"."questionnaire_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research"."question_version_translations" ADD CONSTRAINT "question_version_translations_question_version_id_question_versions_id_fk" FOREIGN KEY ("question_version_id") REFERENCES "research"."question_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research"."question_options" ADD CONSTRAINT "question_options_question_version_id_question_versions_id_fk" FOREIGN KEY ("question_version_id") REFERENCES "research"."question_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research"."question_option_translations" ADD CONSTRAINT "question_option_translations_question_option_id_question_options_id_fk" FOREIGN KEY ("question_option_id") REFERENCES "research"."question_options"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "questionnaires_study_idx" ON "research"."questionnaires" USING btree ("study_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "questionnaire_versions_one_draft_idx" ON "research"."questionnaire_versions" USING btree ("questionnaire_id") WHERE "research"."questionnaire_versions"."status" = 'DRAFT';--> statement-breakpoint
CREATE UNIQUE INDEX "questionnaire_versions_number_key" ON "research"."questionnaire_versions" USING btree ("questionnaire_id","version_number");--> statement-breakpoint
CREATE INDEX "questionnaire_versions_questionnaire_idx" ON "research"."questionnaire_versions" USING btree ("questionnaire_id");--> statement-breakpoint
CREATE UNIQUE INDEX "question_versions_key_key" ON "research"."question_versions" USING btree ("questionnaire_version_id","question_key");--> statement-breakpoint
CREATE INDEX "question_versions_order_idx" ON "research"."question_versions" USING btree ("questionnaire_version_id","display_order");--> statement-breakpoint
CREATE UNIQUE INDEX "question_version_translations_locale_key" ON "research"."question_version_translations" USING btree ("question_version_id","locale");--> statement-breakpoint
CREATE UNIQUE INDEX "question_options_key_key" ON "research"."question_options" USING btree ("question_version_id","option_key");--> statement-breakpoint
CREATE INDEX "question_options_order_idx" ON "research"."question_options" USING btree ("question_version_id","display_order");--> statement-breakpoint
CREATE UNIQUE INDEX "question_option_translations_locale_key" ON "research"."question_option_translations" USING btree ("question_option_id","locale");
--> statement-breakpoint

-- ── updated_at maintenance ──────────────────────────────────────────────────
-- Reuses public.set_updated_at(), created by migration 0000.
CREATE TRIGGER questionnaires_set_updated_at BEFORE UPDATE ON "research"."questionnaires" FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();--> statement-breakpoint
CREATE TRIGGER questionnaire_versions_set_updated_at BEFORE UPDATE ON "research"."questionnaire_versions" FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();--> statement-breakpoint
CREATE TRIGGER question_versions_set_updated_at BEFORE UPDATE ON "research"."question_versions" FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();--> statement-breakpoint
CREATE TRIGGER question_version_translations_set_updated_at BEFORE UPDATE ON "research"."question_version_translations" FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();--> statement-breakpoint
CREATE TRIGGER question_options_set_updated_at BEFORE UPDATE ON "research"."question_options" FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();--> statement-breakpoint
CREATE TRIGGER question_option_translations_set_updated_at BEFORE UPDATE ON "research"."question_option_translations" FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();--> statement-breakpoint

-- ── Publish immutability (STRUCTURE.md §6, AGENT.md §17) ────────────────────
-- "Definitions become immutable once published. Do not add an update path to
-- a published questionnaire or protocol version." Enforced by a BEFORE UPDATE
-- OR DELETE trigger, not only by convention — the same mechanism migration
-- 0000 uses for research.audit_events, because a migration or maintenance
-- connection is a superuser and superusers bypass GRANT.
--
-- Blocking RETIRED as well as PUBLISHED is deliberately the stricter choice:
-- Phase 3 never writes RETIRED, but a retired version was published once and
-- its content must stay exactly what participants who completed it actually
-- saw. A later phase that needs to flip PUBLISHED → RETIRED as a status-only
-- transition will need a migration that relaxes this trigger to permit that
-- one specific change — it should not casually reopen the rest of the row.
CREATE OR REPLACE FUNCTION research.forbid_published_questionnaire_version_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  IF OLD.status IN ('PUBLISHED', 'RETIRED') THEN
    RAISE EXCEPTION 'a published questionnaire version is immutable; % is not permitted', TG_OP
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER questionnaire_versions_published_immutable
  BEFORE UPDATE OR DELETE ON "research"."questionnaire_versions"
  FOR EACH ROW EXECUTE FUNCTION research.forbid_published_questionnaire_version_mutation();
--> statement-breakpoint

-- The three child tables below check their ancestor's status through a
-- subquery rather than duplicating a status column onto every row, which
-- would need to be kept in sync by every write path instead of by one place.
CREATE OR REPLACE FUNCTION research.forbid_published_question_version_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
  parent_status text;
BEGIN
  SELECT status INTO parent_status
  FROM research.questionnaire_versions
  WHERE id = OLD.questionnaire_version_id;

  IF parent_status IN ('PUBLISHED', 'RETIRED') THEN
    RAISE EXCEPTION 'a question under a published questionnaire version is immutable; % is not permitted', TG_OP
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER question_versions_published_immutable
  BEFORE UPDATE OR DELETE ON "research"."question_versions"
  FOR EACH ROW EXECUTE FUNCTION research.forbid_published_question_version_mutation();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION research.forbid_published_question_option_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
  parent_status text;
BEGIN
  SELECT qv.status INTO parent_status
  FROM research.question_versions q
  JOIN research.questionnaire_versions qv ON qv.id = q.questionnaire_version_id
  WHERE q.id = OLD.question_version_id;

  IF parent_status IN ('PUBLISHED', 'RETIRED') THEN
    RAISE EXCEPTION 'an option under a published questionnaire version is immutable; % is not permitted', TG_OP
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER question_options_published_immutable
  BEFORE UPDATE OR DELETE ON "research"."question_options"
  FOR EACH ROW EXECUTE FUNCTION research.forbid_published_question_option_mutation();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION research.forbid_published_question_translation_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
  parent_status text;
BEGIN
  SELECT qv.status INTO parent_status
  FROM research.question_versions q
  JOIN research.questionnaire_versions qv ON qv.id = q.questionnaire_version_id
  WHERE q.id = OLD.question_version_id;

  IF parent_status IN ('PUBLISHED', 'RETIRED') THEN
    RAISE EXCEPTION 'a translation under a published questionnaire version is immutable; % is not permitted', TG_OP
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER question_version_translations_published_immutable
  BEFORE UPDATE OR DELETE ON "research"."question_version_translations"
  FOR EACH ROW EXECUTE FUNCTION research.forbid_published_question_translation_mutation();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION research.forbid_published_option_translation_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
  parent_status text;
BEGIN
  SELECT qv.status INTO parent_status
  FROM research.question_options o
  JOIN research.question_versions q ON q.id = o.question_version_id
  JOIN research.questionnaire_versions qv ON qv.id = q.questionnaire_version_id
  WHERE o.id = OLD.question_option_id;

  IF parent_status IN ('PUBLISHED', 'RETIRED') THEN
    RAISE EXCEPTION 'a translation under a published questionnaire version is immutable; % is not permitted', TG_OP
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER question_option_translations_published_immutable
  BEFORE UPDATE OR DELETE ON "research"."question_option_translations"
  FOR EACH ROW EXECUTE FUNCTION research.forbid_published_option_translation_mutation();