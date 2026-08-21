CREATE TABLE "identity"."participant_credentials" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"participant_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"lookup_prefix" text NOT NULL,
	"issued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	"rotated_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "identity"."participant_recovery_codes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"participant_id" uuid NOT NULL,
	"code_hash" text NOT NULL,
	"issued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"redeemed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "research"."consent_version_translations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"consent_version_id" uuid NOT NULL,
	"locale" text NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "research"."consent_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"study_id" uuid NOT NULL,
	"status" text DEFAULT 'DRAFT' NOT NULL,
	"version_number" integer,
	"published_at" timestamp with time zone,
	"published_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "consent_versions_status_valid" CHECK ("research"."consent_versions"."status" IN ('DRAFT', 'PUBLISHED', 'RETIRED')),
	CONSTRAINT "consent_versions_publication_complete" CHECK (("research"."consent_versions"."status" = 'DRAFT' AND "research"."consent_versions"."version_number" IS NULL AND "research"."consent_versions"."published_at" IS NULL)
          OR ("research"."consent_versions"."status" <> 'DRAFT' AND "research"."consent_versions"."version_number" IS NOT NULL AND "research"."consent_versions"."published_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "research"."study_groups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"study_id" uuid NOT NULL,
	"key" text NOT NULL,
	"label" text NOT NULL,
	"allocation_weight" integer DEFAULT 1 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "study_groups_weight_nonnegative" CHECK ("research"."study_groups"."allocation_weight" >= 0)
);
--> statement-breakpoint
CREATE TABLE "research"."participants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"study_id" uuid NOT NULL,
	"public_code" text NOT NULL,
	"enrolled_at" timestamp with time zone DEFAULT now() NOT NULL,
	"timezone" text,
	"locale" text NOT NULL,
	"status" text DEFAULT 'ACTIVE' NOT NULL,
	"withdrawn_at" timestamp with time zone,
	"withdrawal_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "participants_status_valid" CHECK ("research"."participants"."status" IN ('ACTIVE', 'COMPLETED', 'WITHDRAWN')),
	CONSTRAINT "participants_withdrawal_complete" CHECK (("research"."participants"."status" = 'WITHDRAWN') = ("research"."participants"."withdrawn_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "research"."enrollments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"participant_id" uuid NOT NULL,
	"study_id" uuid NOT NULL,
	"protocol_version_id" uuid NOT NULL,
	"consent_version_id" uuid NOT NULL,
	"consented_at" timestamp with time zone NOT NULL,
	"consent_locale" text NOT NULL,
	"group_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "research"."consent_version_translations" ADD CONSTRAINT "consent_version_translations_consent_version_id_consent_versions_id_fk" FOREIGN KEY ("consent_version_id") REFERENCES "research"."consent_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research"."consent_versions" ADD CONSTRAINT "consent_versions_study_id_studies_id_fk" FOREIGN KEY ("study_id") REFERENCES "research"."studies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research"."consent_versions" ADD CONSTRAINT "consent_versions_published_by_researcher_users_id_fk" FOREIGN KEY ("published_by") REFERENCES "identity"."researcher_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research"."study_groups" ADD CONSTRAINT "study_groups_study_id_studies_id_fk" FOREIGN KEY ("study_id") REFERENCES "research"."studies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research"."participants" ADD CONSTRAINT "participants_study_id_studies_id_fk" FOREIGN KEY ("study_id") REFERENCES "research"."studies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research"."enrollments" ADD CONSTRAINT "enrollments_participant_id_participants_id_fk" FOREIGN KEY ("participant_id") REFERENCES "research"."participants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research"."enrollments" ADD CONSTRAINT "enrollments_study_id_studies_id_fk" FOREIGN KEY ("study_id") REFERENCES "research"."studies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research"."enrollments" ADD CONSTRAINT "enrollments_protocol_version_id_protocol_versions_id_fk" FOREIGN KEY ("protocol_version_id") REFERENCES "research"."protocol_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research"."enrollments" ADD CONSTRAINT "enrollments_consent_version_id_consent_versions_id_fk" FOREIGN KEY ("consent_version_id") REFERENCES "research"."consent_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research"."enrollments" ADD CONSTRAINT "enrollments_group_id_study_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "research"."study_groups"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "participant_credentials_lookup_idx" ON "identity"."participant_credentials" USING btree ("lookup_prefix");--> statement-breakpoint
CREATE INDEX "participant_credentials_participant_idx" ON "identity"."participant_credentials" USING btree ("participant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "participant_credentials_hash_idx" ON "identity"."participant_credentials" USING btree ("token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "participant_recovery_codes_hash_idx" ON "identity"."participant_recovery_codes" USING btree ("code_hash");--> statement-breakpoint
CREATE INDEX "participant_recovery_codes_participant_idx" ON "identity"."participant_recovery_codes" USING btree ("participant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "consent_version_translations_locale_idx" ON "research"."consent_version_translations" USING btree ("consent_version_id","locale");--> statement-breakpoint
CREATE UNIQUE INDEX "consent_versions_one_draft_idx" ON "research"."consent_versions" USING btree ("study_id") WHERE "research"."consent_versions"."status" = 'DRAFT';--> statement-breakpoint
CREATE UNIQUE INDEX "consent_versions_number_idx" ON "research"."consent_versions" USING btree ("study_id","version_number");--> statement-breakpoint
CREATE UNIQUE INDEX "study_groups_key_idx" ON "research"."study_groups" USING btree ("study_id","key");--> statement-breakpoint
CREATE UNIQUE INDEX "participants_public_code_idx" ON "research"."participants" USING btree ("study_id","public_code");--> statement-breakpoint
CREATE INDEX "participants_study_idx" ON "research"."participants" USING btree ("study_id");--> statement-breakpoint
CREATE UNIQUE INDEX "enrollments_participant_idx" ON "research"."enrollments" USING btree ("participant_id");--> statement-breakpoint
CREATE INDEX "enrollments_study_idx" ON "research"."enrollments" USING btree ("study_id");--> statement-breakpoint
CREATE INDEX "enrollments_protocol_version_idx" ON "research"."enrollments" USING btree ("protocol_version_id");--> statement-breakpoint

-- ─────────────────────────────────────────────────────────────────────────────
-- Immutability of published consent versions (FR-05).
--
-- The sharpest case of the three version tables. An enrollment records which
-- consent document the participant agreed to and in which language; if the text
-- behind that reference can change afterwards, the record answers nothing. An
-- ethics committee asking "what exactly did this person consent to on the 4th?"
-- must be able to read it back verbatim.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION research.forbid_published_consent_version_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  IF OLD.status IN ('PUBLISHED', 'RETIRED') THEN
    RAISE EXCEPTION 'a published consent version is immutable; % is not permitted', TG_OP
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER consent_versions_published_immutable
  BEFORE UPDATE OR DELETE ON "research"."consent_versions"
  FOR EACH ROW EXECUTE FUNCTION research.forbid_published_consent_version_mutation();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION research.forbid_published_consent_translation_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
  parent_status text;
BEGIN
  SELECT status INTO parent_status
  FROM research.consent_versions
  WHERE id = OLD.consent_version_id;

  IF parent_status IN ('PUBLISHED', 'RETIRED') THEN
    RAISE EXCEPTION 'consent text under a published version is immutable; % is not permitted', TG_OP
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER consent_version_translations_published_immutable
  BEFORE UPDATE OR DELETE ON "research"."consent_version_translations"
  FOR EACH ROW EXECUTE FUNCTION research.forbid_published_consent_translation_mutation();
--> statement-breakpoint

-- ─────────────────────────────────────────────────────────────────────────────
-- An enrollment is written once and never re-pointed (NFR-17, FR-45).
--
-- Version pinning and group assignment are the two facts that make a
-- participant's data interpretable. Re-pointing a live enrollment at a newer
-- protocol version would re-time measurements already given; re-assigning a
-- group would mean earlier responses came from one condition and later ones
-- from another. Neither is a mistake an application-level rule should be the
-- only thing preventing.
--
-- Consent locale and instant are equally fixed: they are the record of what was
-- agreed to, not settings.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION research.forbid_enrollment_rebinding()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  IF NEW.participant_id IS DISTINCT FROM OLD.participant_id
     OR NEW.study_id IS DISTINCT FROM OLD.study_id
     OR NEW.protocol_version_id IS DISTINCT FROM OLD.protocol_version_id
     OR NEW.consent_version_id IS DISTINCT FROM OLD.consent_version_id
     OR NEW.consent_locale IS DISTINCT FROM OLD.consent_locale
     OR NEW.consented_at IS DISTINCT FROM OLD.consented_at
     OR NEW.group_id IS DISTINCT FROM OLD.group_id THEN
    RAISE EXCEPTION 'an enrollment binding is fixed at enrollment and cannot be changed'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER enrollments_binding_immutable
  BEFORE UPDATE ON "research"."enrollments"
  FOR EACH ROW EXECUTE FUNCTION research.forbid_enrollment_rebinding();
--> statement-breakpoint

-- updated_at maintenance, as on every other table.
CREATE TRIGGER consent_versions_set_updated_at
  BEFORE UPDATE ON "research"."consent_versions"
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint
CREATE TRIGGER consent_version_translations_set_updated_at
  BEFORE UPDATE ON "research"."consent_version_translations"
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint
CREATE TRIGGER study_groups_set_updated_at
  BEFORE UPDATE ON "research"."study_groups"
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint
CREATE TRIGGER participants_set_updated_at
  BEFORE UPDATE ON "research"."participants"
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint
CREATE TRIGGER enrollments_set_updated_at
  BEFORE UPDATE ON "research"."enrollments"
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
