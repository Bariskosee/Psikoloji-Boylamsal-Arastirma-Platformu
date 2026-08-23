CREATE TABLE "identity"."researcher_password_resets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"token_hash" text NOT NULL,
	"user_id" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"requested_ip_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "identity"."researcher_password_resets" ADD CONSTRAINT "researcher_password_resets_user_id_researcher_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "identity"."researcher_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "researcher_password_resets_token_hash_key" ON "identity"."researcher_password_resets" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "researcher_password_resets_user_idx" ON "identity"."researcher_password_resets" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "researcher_password_resets_expires_idx" ON "identity"."researcher_password_resets" USING btree ("expires_at");