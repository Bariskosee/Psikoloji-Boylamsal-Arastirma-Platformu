-- ─────────────────────────────────────────────────────────────────────────────
-- Phase 8 — PWA and push subscription lifecycle (PLAN.md, ADR-006, ADR-007).
--
-- Everything this migration adds lands in the `identity` schema, and that is
-- the point. A push endpoint is a URL that wakes one specific device, and a
-- handoff code is a live capability to become a specific participant. Both are
-- re-identifying data (STRUCTURE.md §11.1), and `app_analytics` — the role
-- every analytics and export code path connects as — holds no privileges on
-- this schema at all. An export that accidentally joins an endpoint therefore
-- fails at the database rather than at review.
--
-- No GRANT statements are needed: migration 0000 set ALTER DEFAULT PRIVILEGES
-- on both schemas, so `app_readwrite` picks these tables up automatically and
-- `app_analytics` does not.
--
-- `participant_credentials.credential_context` is added with a default so the
-- backfill is free and correct: every credential that exists today was minted
-- in a browser, because the installed-application path does not exist until
-- this migration lands.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE "identity"."participant_handoff_codes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"participant_id" uuid NOT NULL,
	"code_hash" text NOT NULL,
	"issued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"redeemed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "participant_handoff_codes_expiry_after_issue" CHECK ("identity"."participant_handoff_codes"."expires_at" > "identity"."participant_handoff_codes"."issued_at")
);
--> statement-breakpoint
CREATE TABLE "identity"."push_subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"participant_id" uuid NOT NULL,
	"endpoint" text NOT NULL,
	"p256dh_key" text NOT NULL,
	"auth_key" text NOT NULL,
	"expiration_time" timestamp with time zone,
	"credential_context" text DEFAULT 'BROWSER' NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"deactivated_at" timestamp with time zone,
	"deactivation_reason" text,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "push_subscriptions_credential_context_valid" CHECK ("identity"."push_subscriptions"."credential_context" IN ('BROWSER', 'INSTALLED')),
	CONSTRAINT "push_subscriptions_deactivation_complete" CHECK (("identity"."push_subscriptions"."is_active" = true AND "identity"."push_subscriptions"."deactivated_at" IS NULL)
          OR ("identity"."push_subscriptions"."is_active" = false AND "identity"."push_subscriptions"."deactivated_at" IS NOT NULL)),
	CONSTRAINT "push_subscriptions_deactivation_reason_valid" CHECK ("identity"."push_subscriptions"."deactivation_reason" IS NULL
          OR "identity"."push_subscriptions"."deactivation_reason" IN ('UNSUBSCRIBED', 'WITHDRAWN', 'EXPIRED', 'REJECTED_BY_SERVICE'))
);
--> statement-breakpoint
ALTER TABLE "identity"."participant_credentials" ADD COLUMN "credential_context" text DEFAULT 'BROWSER' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "participant_handoff_codes_hash_idx" ON "identity"."participant_handoff_codes" USING btree ("code_hash");--> statement-breakpoint
CREATE INDEX "participant_handoff_codes_participant_idx" ON "identity"."participant_handoff_codes" USING btree ("participant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "push_subscriptions_endpoint_idx" ON "identity"."push_subscriptions" USING btree ("endpoint");--> statement-breakpoint
CREATE INDEX "push_subscriptions_participant_idx" ON "identity"."push_subscriptions" USING btree ("participant_id");--> statement-breakpoint
CREATE INDEX "push_subscriptions_prune_idx" ON "identity"."push_subscriptions" USING btree ("deactivated_at") WHERE "identity"."push_subscriptions"."is_active" = false;--> statement-breakpoint
ALTER TABLE "identity"."participant_credentials" ADD CONSTRAINT "participant_credentials_context_valid" CHECK ("identity"."participant_credentials"."credential_context" IN ('BROWSER', 'INSTALLED'));
--> statement-breakpoint

-- updated_at maintenance, as on every other table.
CREATE TRIGGER push_subscriptions_set_updated_at
  BEFORE UPDATE ON "identity"."push_subscriptions"
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
