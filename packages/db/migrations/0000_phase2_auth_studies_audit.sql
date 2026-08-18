-- ─────────────────────────────────────────────────────────────────────────────
-- Phase 2 — researcher authentication, studies, membership, audit.
--
-- Creates the `research` and `identity` schemas, both application roles, and
-- the five tables Phase 2 needs. Written defensively (IF NOT EXISTS on every
-- shared object) because PLAN.md gives Phase 1 ownership of the complete
-- schema: when that branch merges, the shared objects here must not collide,
-- and its table definitions take precedence over these.
--
-- The privilege model is the part that cannot be expressed in the Drizzle
-- schema and is the reason this file is hand-finished rather than purely
-- generated. See ADR-003 and NFR-03.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE SCHEMA IF NOT EXISTS "identity";
--> statement-breakpoint
CREATE SCHEMA IF NOT EXISTS "research";
--> statement-breakpoint

-- ── Roles (ADR-003, NFR-03) ─────────────────────────────────────────────────
-- NOLOGIN group roles. The deployment grants them to the actual login users,
-- so credentials never appear in a migration.
--
-- `app_analytics` is the enforcement mechanism behind NFR-03: every analytics
-- and export code path connects as this role, so a query that accidentally
-- joins a push endpoint or a password hash fails at the database, in CI,
-- before review — rather than silently succeeding and leaking.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_readwrite') THEN
    CREATE ROLE app_readwrite NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_analytics') THEN
    CREATE ROLE app_analytics NOLOGIN;
  END IF;
END
$$;
--> statement-breakpoint

-- ── identity — re-identifying data and authentication secrets ───────────────
CREATE TABLE "identity"."researcher_users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"password_hash" text NOT NULL,
	"display_name" text NOT NULL,
	"locale" text DEFAULT 'en' NOT NULL,
	"is_admin" boolean DEFAULT false NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"password_changed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_login_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "researcher_users_email_lowercase" CHECK ("identity"."researcher_users"."email" = lower("identity"."researcher_users"."email")),
	CONSTRAINT "researcher_users_email_shape" CHECK ("identity"."researcher_users"."email" LIKE '%_@_%'),
	CONSTRAINT "researcher_users_locale_valid" CHECK ("identity"."researcher_users"."locale" IN ('en', 'tr'))
);
--> statement-breakpoint
CREATE TABLE "identity"."researcher_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"token_hash" text NOT NULL,
	"csrf_token_hash" text NOT NULL,
	"user_id" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	"ip_hash" text,
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

-- ── research — canonical research data ──────────────────────────────────────
CREATE TABLE "research"."studies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'DRAFT' NOT NULL,
	"enrollment_code" text NOT NULL,
	"timezone" text NOT NULL,
	"default_locale" text DEFAULT 'en' NOT NULL,
	"supported_locales" text[] NOT NULL,
	"enrollment_capacity" integer,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "studies_status_valid" CHECK ("research"."studies"."status" IN ('DRAFT', 'ACTIVE', 'PAUSED', 'CLOSED', 'ARCHIVED')),
	CONSTRAINT "studies_enrollment_code_shape" CHECK ("research"."studies"."enrollment_code" ~ '^[0-9A-HJKMNP-TV-Z]{6}$'),
	CONSTRAINT "studies_supported_locales_nonempty" CHECK (array_length("research"."studies"."supported_locales", 1) >= 1),
	CONSTRAINT "studies_default_locale_supported" CHECK ("research"."studies"."default_locale" = ANY("research"."studies"."supported_locales")),
	CONSTRAINT "studies_capacity_positive" CHECK ("research"."studies"."enrollment_capacity" IS NULL OR "research"."studies"."enrollment_capacity" > 0)
);
--> statement-breakpoint
CREATE TABLE "research"."study_members" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"study_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" text NOT NULL,
	"added_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "study_members_role_valid" CHECK ("research"."study_members"."role" IN ('OWNER', 'EDITOR', 'ANALYST', 'VIEWER'))
);
--> statement-breakpoint
CREATE TABLE "research"."audit_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor_type" text NOT NULL,
	"actor_id" uuid,
	"actor_label" text,
	"study_id" uuid,
	"action" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"ip_hash" text,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "audit_events_actor_type_valid" CHECK ("research"."audit_events"."actor_type" IN ('RESEARCHER', 'PARTICIPANT', 'SYSTEM'))
);
--> statement-breakpoint

-- ── Foreign keys ────────────────────────────────────────────────────────────
ALTER TABLE "identity"."researcher_sessions" ADD CONSTRAINT "researcher_sessions_user_id_researcher_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "identity"."researcher_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research"."studies" ADD CONSTRAINT "studies_created_by_researcher_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "identity"."researcher_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research"."study_members" ADD CONSTRAINT "study_members_study_id_studies_id_fk" FOREIGN KEY ("study_id") REFERENCES "research"."studies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research"."study_members" ADD CONSTRAINT "study_members_user_id_researcher_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "identity"."researcher_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research"."study_members" ADD CONSTRAINT "study_members_added_by_researcher_users_id_fk" FOREIGN KEY ("added_by") REFERENCES "identity"."researcher_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
-- No cascade: the audit trail must outlive anything it describes (NFR-05).
ALTER TABLE "research"."audit_events" ADD CONSTRAINT "audit_events_study_id_studies_id_fk" FOREIGN KEY ("study_id") REFERENCES "research"."studies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint

-- ── Indexes ─────────────────────────────────────────────────────────────────
CREATE UNIQUE INDEX "researcher_users_email_key" ON "identity"."researcher_users" USING btree ("email");--> statement-breakpoint
CREATE INDEX "researcher_users_active_idx" ON "identity"."researcher_users" USING btree ("is_active");--> statement-breakpoint
CREATE UNIQUE INDEX "researcher_sessions_token_hash_key" ON "identity"."researcher_sessions" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "researcher_sessions_user_idx" ON "identity"."researcher_sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "researcher_sessions_expires_idx" ON "identity"."researcher_sessions" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "studies_enrollment_code_key" ON "research"."studies" USING btree ("enrollment_code");--> statement-breakpoint
CREATE INDEX "studies_status_idx" ON "research"."studies" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "study_members_study_user_key" ON "research"."study_members" USING btree ("study_id","user_id");--> statement-breakpoint
CREATE INDEX "study_members_user_idx" ON "research"."study_members" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "audit_events_study_occurred_idx" ON "research"."audit_events" USING btree ("study_id","occurred_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "audit_events_actor_idx" ON "research"."audit_events" USING btree ("actor_id","occurred_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "audit_events_action_idx" ON "research"."audit_events" USING btree ("action","occurred_at" DESC NULLS LAST);--> statement-breakpoint

-- ── updated_at maintenance ──────────────────────────────────────────────────
-- A trigger rather than an application convention: `updated_at` is evidence in
-- an audit conversation, and evidence that depends on every future code path
-- remembering to set a column is not evidence. `search_path` is pinned so the
-- function cannot be hijacked by a caller's search path.
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER researcher_users_set_updated_at BEFORE UPDATE ON "identity"."researcher_users" FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();--> statement-breakpoint
CREATE TRIGGER studies_set_updated_at BEFORE UPDATE ON "research"."studies" FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();--> statement-breakpoint
CREATE TRIGGER study_members_set_updated_at BEFORE UPDATE ON "research"."study_members" FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();--> statement-breakpoint

-- ── audit_events is append-only ─────────────────────────────────────────────
-- Enforced by a trigger, not only by revoked privileges, because the migration
-- and maintenance connections are superusers and superusers bypass GRANT. An
-- audit trail that a privileged connection can quietly rewrite provides no
-- assurance at all. This is the same mechanism Phase 1 uses to freeze
-- published questionnaire and protocol versions.
CREATE OR REPLACE FUNCTION research.forbid_audit_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  RAISE EXCEPTION 'research.audit_events is append-only; % is not permitted', TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER audit_events_append_only
  BEFORE UPDATE OR DELETE ON "research"."audit_events"
  FOR EACH ROW EXECUTE FUNCTION research.forbid_audit_mutation();
--> statement-breakpoint

-- ── Privileges (ADR-003, NFR-03) ────────────────────────────────────────────
-- Nothing is granted to PUBLIC. A new schema grants PUBLIC no privileges by
-- default; this states it explicitly so a later `GRANT ... TO PUBLIC` stands
-- out as the deliberate act it would have to be.
REVOKE ALL ON SCHEMA "identity" FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON SCHEMA "research" FROM PUBLIC;
--> statement-breakpoint

GRANT USAGE ON SCHEMA "research", "identity" TO app_readwrite;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA "research" TO app_readwrite;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA "identity" TO app_readwrite;
--> statement-breakpoint
-- Tables created by later migrations inherit these grants, so Phase 1 does not
-- have to remember to re-grant.
ALTER DEFAULT PRIVILEGES IN SCHEMA "research" GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_readwrite;
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA "identity" GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_readwrite;
--> statement-breakpoint

-- The application role may append to the audit trail but not rewrite it.
REVOKE UPDATE, DELETE ON "research"."audit_events" FROM app_readwrite;
--> statement-breakpoint

-- `app_analytics`: SELECT on research, and NOTHING on identity. The absence of
-- any GRANT on "identity" below is the whole point of the two-schema split.
GRANT USAGE ON SCHEMA "research" TO app_analytics;
--> statement-breakpoint
GRANT SELECT ON ALL TABLES IN SCHEMA "research" TO app_analytics;
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA "research" GRANT SELECT ON TABLES TO app_analytics;
--> statement-breakpoint
REVOKE ALL ON SCHEMA "identity" FROM app_analytics;
--> statement-breakpoint
REVOKE ALL ON ALL TABLES IN SCHEMA "identity" FROM app_analytics;
