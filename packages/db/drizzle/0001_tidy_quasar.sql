CREATE TABLE "api_rate_limit_buckets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"api_key_id" uuid,
	"bucket_key" text NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "api_rate_limit_buckets" ADD CONSTRAINT "api_rate_limit_buckets_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_rate_limit_buckets" ADD CONSTRAINT "api_rate_limit_buckets_api_key_id_api_keys_id_fk" FOREIGN KEY ("api_key_id") REFERENCES "public"."api_keys"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "api_rate_limit_org_bucket_uidx" ON "api_rate_limit_buckets" USING btree ("organization_id","bucket_key");--> statement-breakpoint
CREATE INDEX "api_rate_limit_window_idx" ON "api_rate_limit_buckets" USING btree ("window_start");