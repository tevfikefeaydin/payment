CREATE TYPE "public"."actor_type" AS ENUM('user', 'api_key', 'system');--> statement-breakpoint
CREATE TYPE "public"."billing_subscription_status" AS ENUM('trialing', 'active', 'past_due', 'canceled', 'incomplete', 'incomplete_expired', 'unpaid', 'paused');--> statement-breakpoint
CREATE TYPE "public"."connection_status" AS ENUM('pending_validation', 'active', 'disabled', 'revoked');--> statement-breakpoint
CREATE TYPE "public"."exception_severity" AS ENUM('critical', 'high', 'medium', 'low');--> statement-breakpoint
CREATE TYPE "public"."exception_state" AS ENUM('open', 'acknowledged', 'resolved', 'reopened');--> statement-breakpoint
CREATE TYPE "public"."import_status" AS ENUM('uploaded', 'mapping', 'validating', 'queued', 'processing', 'completed', 'completed_with_errors', 'failed', 'canceled');--> statement-breakpoint
CREATE TYPE "public"."internal_payment_status" AS ENUM('pending', 'paid', 'failed', 'refunded', 'partially_refunded');--> statement-breakpoint
CREATE TYPE "public"."notification_delivery_status" AS ENUM('pending', 'sent', 'failed', 'skipped');--> statement-breakpoint
CREATE TYPE "public"."notification_destination_status" AS ENUM('pending_verification', 'active', 'disabled', 'failing');--> statement-breakpoint
CREATE TYPE "public"."notification_digest" AS ENUM('immediate', 'hourly', 'daily');--> statement-breakpoint
CREATE TYPE "public"."notification_kind" AS ENUM('email', 'slack');--> statement-breakpoint
CREATE TYPE "public"."organization_role" AS ENUM('owner', 'admin', 'analyst', 'viewer');--> statement-breakpoint
CREATE TYPE "public"."plan_key" AS ENUM('free', 'starter', 'growth', 'scale');--> statement-breakpoint
CREATE TYPE "public"."provider_invoice_status" AS ENUM('draft', 'open', 'paid', 'uncollectible', 'void');--> statement-breakpoint
CREATE TYPE "public"."provider_payment_status" AS ENUM('succeeded', 'processing', 'requires_action', 'requires_payment_method', 'canceled', 'failed');--> statement-breakpoint
CREATE TYPE "public"."provider_refund_status" AS ENUM('succeeded', 'pending', 'failed', 'canceled');--> statement-breakpoint
CREATE TYPE "public"."provider_subscription_status" AS ENUM('trialing', 'active', 'past_due', 'canceled', 'unpaid', 'incomplete', 'incomplete_expired', 'paused');--> statement-breakpoint
CREATE TYPE "public"."reconciliation_run_status" AS ENUM('queued', 'running', 'succeeded', 'failed');--> statement-breakpoint
CREATE TYPE "public"."record_source" AS ENUM('csv', 'api', 'demo');--> statement-breakpoint
CREATE TYPE "public"."run_trigger" AS ENUM('manual', 'scheduled', 'import', 'sync');--> statement-breakpoint
CREATE TYPE "public"."sync_resource" AS ENUM('customers', 'payment_intents', 'charges', 'invoices', 'subscriptions', 'refunds', 'disputes', 'balance_transactions', 'payouts');--> statement-breakpoint
CREATE TYPE "public"."sync_status" AS ENUM('queued', 'running', 'succeeded', 'failed', 'partial');--> statement-breakpoint
CREATE TYPE "public"."webhook_processing_status" AS ENUM('received', 'processed', 'ignored', 'failed');--> statement-breakpoint
CREATE TABLE "auth_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"purpose" text NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	"ip_hash" text,
	"user_agent" text
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"email_verified_at" timestamp with time zone,
	"password_hash" text NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"disabled_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "invitations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"email" text NOT NULL,
	"role" "organization_role" NOT NULL,
	"token_hash" text NOT NULL,
	"invited_by_user_id" uuid,
	"expires_at" timestamp with time zone NOT NULL,
	"accepted_at" timestamp with time zone,
	"accepted_by_user_id" uuid,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "organization_members" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" "organization_role" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "organizations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"plan_key" "plan_key" DEFAULT 'free' NOT NULL,
	"retention_days" integer DEFAULT 90 NOT NULL,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"is_demo" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "organizations_retention_bounds" CHECK ("organizations"."retention_days" between 7 and 365),
	CONSTRAINT "organizations_slug_format" CHECK ("organizations"."slug" ~ '^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$')
);
--> statement-breakpoint
CREATE TABLE "provider_balance_transactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"provider_id" text NOT NULL,
	"type" text NOT NULL,
	"amount_minor" bigint NOT NULL,
	"fee_minor" bigint DEFAULT 0 NOT NULL,
	"net_minor" bigint NOT NULL,
	"currency" text NOT NULL,
	"source_id" text,
	"provider_created_at" timestamp with time zone NOT NULL,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "provider_customers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"provider_id" text NOT NULL,
	"email" text,
	"name" text,
	"provider_created_at" timestamp with time zone NOT NULL,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "provider_disputes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"provider_id" text NOT NULL,
	"provider_payment_id" text,
	"amount_minor" bigint NOT NULL,
	"currency" text NOT NULL,
	"status" text NOT NULL,
	"reason" text,
	"provider_created_at" timestamp with time zone NOT NULL,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "provider_invoices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"provider_id" text NOT NULL,
	"status" "provider_invoice_status" NOT NULL,
	"amount_due_minor" bigint NOT NULL,
	"amount_paid_minor" bigint DEFAULT 0 NOT NULL,
	"currency" text NOT NULL,
	"provider_customer_id" text,
	"provider_subscription_id" text,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"provider_created_at" timestamp with time zone NOT NULL,
	"paid_at" timestamp with time zone,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "provider_invoices_currency_upper" CHECK ("provider_invoices"."currency" ~ '^[A-Z]{3}$')
);
--> statement-breakpoint
CREATE TABLE "provider_payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"provider_id" text NOT NULL,
	"kind" text NOT NULL,
	"status" "provider_payment_status" NOT NULL,
	"amount_minor" bigint NOT NULL,
	"amount_refunded_minor" bigint DEFAULT 0 NOT NULL,
	"currency" text NOT NULL,
	"provider_customer_id" text,
	"provider_invoice_id" text,
	"payment_intent_id" text,
	"disputed" boolean DEFAULT false NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"provider_created_at" timestamp with time zone NOT NULL,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "provider_payments_currency_upper" CHECK ("provider_payments"."currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "provider_payments_amount_nonneg" CHECK ("provider_payments"."amount_minor" >= 0),
	CONSTRAINT "provider_payments_refund_nonneg" CHECK ("provider_payments"."amount_refunded_minor" >= 0)
);
--> statement-breakpoint
CREATE TABLE "provider_payouts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"provider_id" text NOT NULL,
	"amount_minor" bigint NOT NULL,
	"currency" text NOT NULL,
	"status" text NOT NULL,
	"arrival_date" timestamp with time zone,
	"provider_created_at" timestamp with time zone NOT NULL,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "provider_refunds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"provider_id" text NOT NULL,
	"provider_payment_id" text,
	"amount_minor" bigint NOT NULL,
	"currency" text NOT NULL,
	"status" "provider_refund_status" NOT NULL,
	"provider_created_at" timestamp with time zone NOT NULL,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "provider_refunds_currency_upper" CHECK ("provider_refunds"."currency" ~ '^[A-Z]{3}$')
);
--> statement-breakpoint
CREATE TABLE "provider_subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"provider_id" text NOT NULL,
	"status" "provider_subscription_status" NOT NULL,
	"provider_customer_id" text,
	"currency" text NOT NULL,
	"provider_created_at" timestamp with time zone NOT NULL,
	"canceled_at" timestamp with time zone,
	"current_period_start" timestamp with time zone,
	"current_period_end" timestamp with time zone,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "stripe_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"stripe_account_id" text,
	"account_display_name" text,
	"livemode" boolean DEFAULT false NOT NULL,
	"status" "connection_status" DEFAULT 'pending_validation' NOT NULL,
	"last_validated_at" timestamp with time zone,
	"last_validation_error" text,
	"readable_resources" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"disabled_at" timestamp with time zone,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "stripe_credentials" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"ciphertext" "bytea" NOT NULL,
	"nonce" "bytea" NOT NULL,
	"auth_tag" "bytea" NOT NULL,
	"key_id" text NOT NULL,
	"encryption_version" integer DEFAULT 1 NOT NULL,
	"key_kind" text NOT NULL,
	"key_last_four" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "stripe_credentials_last_four_len" CHECK (length("stripe_credentials"."key_last_four") <= 4)
);
--> statement-breakpoint
CREATE TABLE "sync_checkpoints" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"resource" "sync_resource" NOT NULL,
	"cursor" text,
	"synced_through" timestamp with time zone,
	"last_successful_at" timestamp with time zone,
	"last_attempted_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sync_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"status" "sync_status" DEFAULT 'queued' NOT NULL,
	"is_initial" boolean DEFAULT false NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"stats" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"error_category" text,
	"error_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "api_idempotency_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"api_key_id" uuid,
	"idempotency_key" text NOT NULL,
	"request_hash" text NOT NULL,
	"response_status" integer,
	"response_body" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "api_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"prefix" text NOT NULL,
	"key_hash" text NOT NULL,
	"scopes" jsonb DEFAULT '["records:write"]'::jsonb NOT NULL,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "import_batches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"filename" text NOT NULL,
	"byte_size" integer NOT NULL,
	"status" "import_status" DEFAULT 'uploaded' NOT NULL,
	"mapping" jsonb,
	"headers" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"total_rows" integer DEFAULT 0 NOT NULL,
	"valid_rows" integer DEFAULT 0 NOT NULL,
	"error_rows" integer DEFAULT 0 NOT NULL,
	"inserted_rows" integer DEFAULT 0 NOT NULL,
	"updated_rows" integer DEFAULT 0 NOT NULL,
	"raw_content" text,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"error_message" text
);
--> statement-breakpoint
CREATE TABLE "import_row_errors" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"batch_id" uuid NOT NULL,
	"row_number" integer NOT NULL,
	"column" text,
	"message" text NOT NULL,
	"value_excerpt" text
);
--> statement-breakpoint
CREATE TABLE "internal_payment_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"external_id" text NOT NULL,
	"customer_id" text,
	"order_id" text,
	"subscription_id" text,
	"provider_transaction_id" text,
	"amount_minor" bigint NOT NULL,
	"currency" text NOT NULL,
	"status" "internal_payment_status" NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"record_updated_at" timestamp with time zone,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"source" "record_source" NOT NULL,
	"import_batch_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "internal_records_currency_upper" CHECK ("internal_payment_records"."currency" ~ '^[A-Z]{3}$')
);
--> statement-breakpoint
CREATE TABLE "mapping_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"mapping" jsonb NOT NULL,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "usage_counters" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"period" text NOT NULL,
	"metric" text NOT NULL,
	"count" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "usage_counters_period_format" CHECK ("usage_counters"."period" ~ '^[0-9]{4}-[0-9]{2}$')
);
--> statement-breakpoint
CREATE TABLE "exception_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"exception_id" uuid NOT NULL,
	"action" text NOT NULL,
	"from_state" "exception_state",
	"to_state" "exception_state",
	"actor_type" "actor_type" NOT NULL,
	"actor_user_id" uuid,
	"note" text,
	"correlation_id" text,
	"run_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "exception_events_note_len" CHECK ("exception_events"."note" is null or length("exception_events"."note") <= 2000)
);
--> statement-breakpoint
CREATE TABLE "exceptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"rule_id" text NOT NULL,
	"rule_version" integer NOT NULL,
	"fingerprint" text NOT NULL,
	"severity" "exception_severity" NOT NULL,
	"state" "exception_state" DEFAULT 'open' NOT NULL,
	"summary" text NOT NULL,
	"revenue_at_risk_minor" bigint,
	"currency" text,
	"provider_object_id" text,
	"internal_record_id" uuid,
	"internal_external_id" text,
	"evidence" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"probable_causes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"recommended_actions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"occurred_at" timestamp with time zone,
	"assigned_to_user_id" uuid,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	"resolved_by_user_id" uuid,
	"first_run_id" uuid,
	"last_run_id" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "exceptions_currency_upper" CHECK ("exceptions"."currency" is null or "exceptions"."currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "exceptions_risk_requires_currency" CHECK ("exceptions"."revenue_at_risk_minor" is null or "exceptions"."currency" is not null)
);
--> statement-breakpoint
CREATE TABLE "reconciliation_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"status" "reconciliation_run_status" DEFAULT 'queued' NOT NULL,
	"trigger" "run_trigger" NOT NULL,
	"rule_version" integer NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"counts" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"diagnostics" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"source_snapshot" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"triggered_by_user_id" uuid,
	"error_category" text,
	"error_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notification_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"policy_id" uuid,
	"destination_id" uuid NOT NULL,
	"dedupe_key" text NOT NULL,
	"status" "notification_delivery_status" DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"summary" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"exception_count" integer DEFAULT 0 NOT NULL,
	"scheduled_for" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notification_delivery_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"delivery_id" uuid NOT NULL,
	"exception_id" uuid NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notification_destinations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"kind" "notification_kind" NOT NULL,
	"name" text NOT NULL,
	"target" text,
	"secret_ciphertext" "bytea",
	"secret_nonce" "bytea",
	"secret_auth_tag" "bytea",
	"secret_key_id" text,
	"secret_hint" text,
	"status" "notification_destination_status" DEFAULT 'pending_verification' NOT NULL,
	"verified_at" timestamp with time zone,
	"last_error_at" timestamp with time zone,
	"last_error" text,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notification_policies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"destination_id" uuid NOT NULL,
	"min_severity" "exception_severity" DEFAULT 'high' NOT NULL,
	"min_revenue_at_risk_minor" bigint,
	"currency" text,
	"digest" "notification_digest" DEFAULT 'hourly' NOT NULL,
	"critical_bypasses_digest" boolean DEFAULT true NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "billing_customers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"stripe_customer_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "billing_subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"stripe_subscription_id" text NOT NULL,
	"status" "billing_subscription_status" NOT NULL,
	"plan_key" "plan_key" NOT NULL,
	"stripe_price_id" text,
	"current_period_end" timestamp with time zone,
	"cancel_at_period_end" boolean DEFAULT false NOT NULL,
	"trial_ends_at" timestamp with time zone,
	"canceled_at" timestamp with time zone,
	"last_event_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "billing_webhook_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"stripe_event_id" text NOT NULL,
	"type" text NOT NULL,
	"organization_id" uuid,
	"status" "webhook_processing_status" DEFAULT 'received' NOT NULL,
	"event_created_at" timestamp with time zone,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	"attempts" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"error_message" text
);
--> statement-breakpoint
CREATE TABLE "audit_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid,
	"actor_type" "actor_type" NOT NULL,
	"actor_user_id" uuid,
	"actor_api_key_id" uuid,
	"action" text NOT NULL,
	"target_type" text,
	"target_id" text,
	"correlation_id" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"ip_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "auth_tokens" ADD CONSTRAINT "auth_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_invited_by_user_id_users_id_fk" FOREIGN KEY ("invited_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_accepted_by_user_id_users_id_fk" FOREIGN KEY ("accepted_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_members" ADD CONSTRAINT "organization_members_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_members" ADD CONSTRAINT "organization_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_balance_transactions" ADD CONSTRAINT "provider_balance_transactions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_balance_transactions" ADD CONSTRAINT "provider_balance_transactions_connection_id_stripe_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."stripe_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_customers" ADD CONSTRAINT "provider_customers_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_customers" ADD CONSTRAINT "provider_customers_connection_id_stripe_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."stripe_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_disputes" ADD CONSTRAINT "provider_disputes_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_disputes" ADD CONSTRAINT "provider_disputes_connection_id_stripe_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."stripe_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_invoices" ADD CONSTRAINT "provider_invoices_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_invoices" ADD CONSTRAINT "provider_invoices_connection_id_stripe_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."stripe_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_payments" ADD CONSTRAINT "provider_payments_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_payments" ADD CONSTRAINT "provider_payments_connection_id_stripe_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."stripe_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_payouts" ADD CONSTRAINT "provider_payouts_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_payouts" ADD CONSTRAINT "provider_payouts_connection_id_stripe_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."stripe_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_refunds" ADD CONSTRAINT "provider_refunds_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_refunds" ADD CONSTRAINT "provider_refunds_connection_id_stripe_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."stripe_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_subscriptions" ADD CONSTRAINT "provider_subscriptions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_subscriptions" ADD CONSTRAINT "provider_subscriptions_connection_id_stripe_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."stripe_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stripe_connections" ADD CONSTRAINT "stripe_connections_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stripe_connections" ADD CONSTRAINT "stripe_connections_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stripe_credentials" ADD CONSTRAINT "stripe_credentials_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stripe_credentials" ADD CONSTRAINT "stripe_credentials_connection_id_stripe_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."stripe_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_checkpoints" ADD CONSTRAINT "sync_checkpoints_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_checkpoints" ADD CONSTRAINT "sync_checkpoints_connection_id_stripe_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."stripe_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_runs" ADD CONSTRAINT "sync_runs_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_runs" ADD CONSTRAINT "sync_runs_connection_id_stripe_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."stripe_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_idempotency_records" ADD CONSTRAINT "api_idempotency_records_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_idempotency_records" ADD CONSTRAINT "api_idempotency_records_api_key_id_api_keys_id_fk" FOREIGN KEY ("api_key_id") REFERENCES "public"."api_keys"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_batches" ADD CONSTRAINT "import_batches_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_batches" ADD CONSTRAINT "import_batches_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_row_errors" ADD CONSTRAINT "import_row_errors_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_row_errors" ADD CONSTRAINT "import_row_errors_batch_id_import_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."import_batches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "internal_payment_records" ADD CONSTRAINT "internal_payment_records_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mapping_templates" ADD CONSTRAINT "mapping_templates_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mapping_templates" ADD CONSTRAINT "mapping_templates_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_counters" ADD CONSTRAINT "usage_counters_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exception_events" ADD CONSTRAINT "exception_events_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exception_events" ADD CONSTRAINT "exception_events_exception_id_exceptions_id_fk" FOREIGN KEY ("exception_id") REFERENCES "public"."exceptions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exception_events" ADD CONSTRAINT "exception_events_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exception_events" ADD CONSTRAINT "exception_events_run_id_reconciliation_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."reconciliation_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exceptions" ADD CONSTRAINT "exceptions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exceptions" ADD CONSTRAINT "exceptions_assigned_to_user_id_users_id_fk" FOREIGN KEY ("assigned_to_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exceptions" ADD CONSTRAINT "exceptions_resolved_by_user_id_users_id_fk" FOREIGN KEY ("resolved_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exceptions" ADD CONSTRAINT "exceptions_first_run_id_reconciliation_runs_id_fk" FOREIGN KEY ("first_run_id") REFERENCES "public"."reconciliation_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exceptions" ADD CONSTRAINT "exceptions_last_run_id_reconciliation_runs_id_fk" FOREIGN KEY ("last_run_id") REFERENCES "public"."reconciliation_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reconciliation_runs" ADD CONSTRAINT "reconciliation_runs_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reconciliation_runs" ADD CONSTRAINT "reconciliation_runs_triggered_by_user_id_users_id_fk" FOREIGN KEY ("triggered_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_deliveries" ADD CONSTRAINT "notification_deliveries_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_deliveries" ADD CONSTRAINT "notification_deliveries_policy_id_notification_policies_id_fk" FOREIGN KEY ("policy_id") REFERENCES "public"."notification_policies"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_deliveries" ADD CONSTRAINT "notification_deliveries_destination_id_notification_destinations_id_fk" FOREIGN KEY ("destination_id") REFERENCES "public"."notification_destinations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_delivery_items" ADD CONSTRAINT "notification_delivery_items_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_delivery_items" ADD CONSTRAINT "notification_delivery_items_delivery_id_notification_deliveries_id_fk" FOREIGN KEY ("delivery_id") REFERENCES "public"."notification_deliveries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_delivery_items" ADD CONSTRAINT "notification_delivery_items_exception_id_exceptions_id_fk" FOREIGN KEY ("exception_id") REFERENCES "public"."exceptions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_destinations" ADD CONSTRAINT "notification_destinations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_destinations" ADD CONSTRAINT "notification_destinations_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_policies" ADD CONSTRAINT "notification_policies_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_policies" ADD CONSTRAINT "notification_policies_destination_id_notification_destinations_id_fk" FOREIGN KEY ("destination_id") REFERENCES "public"."notification_destinations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_customers" ADD CONSTRAINT "billing_customers_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_subscriptions" ADD CONSTRAINT "billing_subscriptions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_webhook_events" ADD CONSTRAINT "billing_webhook_events_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "auth_tokens_hash_uidx" ON "auth_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "auth_tokens_user_purpose_idx" ON "auth_tokens" USING btree ("user_id","purpose");--> statement-breakpoint
CREATE UNIQUE INDEX "sessions_token_hash_uidx" ON "sessions" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "sessions_user_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "sessions_expires_idx" ON "sessions" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_lower_uidx" ON "users" USING btree (lower("email"));--> statement-breakpoint
CREATE UNIQUE INDEX "invitations_token_hash_uidx" ON "invitations" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "invitations_org_idx" ON "invitations" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "invitations_org_email_pending_uidx" ON "invitations" USING btree ("organization_id",lower("email")) WHERE "invitations"."accepted_at" is null and "invitations"."revoked_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "organization_members_org_user_uidx" ON "organization_members" USING btree ("organization_id","user_id");--> statement-breakpoint
CREATE INDEX "organization_members_user_idx" ON "organization_members" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "organization_members_org_role_idx" ON "organization_members" USING btree ("organization_id","role");--> statement-breakpoint
CREATE UNIQUE INDEX "organizations_slug_uidx" ON "organizations" USING btree ("slug");--> statement-breakpoint
CREATE UNIQUE INDEX "provider_balance_txn_org_provider_uidx" ON "provider_balance_transactions" USING btree ("organization_id","provider_id");--> statement-breakpoint
CREATE UNIQUE INDEX "provider_customers_org_provider_uidx" ON "provider_customers" USING btree ("organization_id","provider_id");--> statement-breakpoint
CREATE UNIQUE INDEX "provider_disputes_org_provider_uidx" ON "provider_disputes" USING btree ("organization_id","provider_id");--> statement-breakpoint
CREATE UNIQUE INDEX "provider_invoices_org_provider_uidx" ON "provider_invoices" USING btree ("organization_id","provider_id");--> statement-breakpoint
CREATE INDEX "provider_invoices_org_subscription_idx" ON "provider_invoices" USING btree ("organization_id","provider_subscription_id");--> statement-breakpoint
CREATE UNIQUE INDEX "provider_payments_org_provider_uidx" ON "provider_payments" USING btree ("organization_id","provider_id");--> statement-breakpoint
CREATE INDEX "provider_payments_org_status_created_idx" ON "provider_payments" USING btree ("organization_id","status","provider_created_at");--> statement-breakpoint
CREATE INDEX "provider_payments_org_customer_idx" ON "provider_payments" USING btree ("organization_id","provider_customer_id");--> statement-breakpoint
CREATE UNIQUE INDEX "provider_payouts_org_provider_uidx" ON "provider_payouts" USING btree ("organization_id","provider_id");--> statement-breakpoint
CREATE UNIQUE INDEX "provider_refunds_org_provider_uidx" ON "provider_refunds" USING btree ("organization_id","provider_id");--> statement-breakpoint
CREATE INDEX "provider_refunds_org_payment_idx" ON "provider_refunds" USING btree ("organization_id","provider_payment_id");--> statement-breakpoint
CREATE UNIQUE INDEX "provider_subscriptions_org_provider_uidx" ON "provider_subscriptions" USING btree ("organization_id","provider_id");--> statement-breakpoint
CREATE INDEX "provider_subscriptions_org_customer_idx" ON "provider_subscriptions" USING btree ("organization_id","provider_customer_id");--> statement-breakpoint
CREATE INDEX "stripe_connections_org_idx" ON "stripe_connections" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "stripe_connections_org_account_uidx" ON "stripe_connections" USING btree ("organization_id","stripe_account_id") WHERE "stripe_connections"."deleted_at" is null and "stripe_connections"."stripe_account_id" is not null;--> statement-breakpoint
CREATE INDEX "stripe_credentials_connection_idx" ON "stripe_credentials" USING btree ("connection_id");--> statement-breakpoint
CREATE UNIQUE INDEX "stripe_credentials_active_uidx" ON "stripe_credentials" USING btree ("connection_id") WHERE "stripe_credentials"."revoked_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "sync_checkpoints_connection_resource_uidx" ON "sync_checkpoints" USING btree ("connection_id","resource");--> statement-breakpoint
CREATE INDEX "sync_checkpoints_org_idx" ON "sync_checkpoints" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "sync_runs_org_connection_idx" ON "sync_runs" USING btree ("organization_id","connection_id");--> statement-breakpoint
CREATE INDEX "sync_runs_created_idx" ON "sync_runs" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "api_idempotency_org_key_uidx" ON "api_idempotency_records" USING btree ("organization_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "api_idempotency_expires_idx" ON "api_idempotency_records" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "api_keys_hash_uidx" ON "api_keys" USING btree ("key_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "api_keys_prefix_uidx" ON "api_keys" USING btree ("prefix");--> statement-breakpoint
CREATE INDEX "api_keys_org_idx" ON "api_keys" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "import_batches_org_created_idx" ON "import_batches" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE INDEX "import_row_errors_batch_idx" ON "import_row_errors" USING btree ("batch_id","row_number");--> statement-breakpoint
CREATE INDEX "import_row_errors_org_idx" ON "import_row_errors" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "internal_records_org_external_uidx" ON "internal_payment_records" USING btree ("organization_id","external_id");--> statement-breakpoint
CREATE INDEX "internal_records_org_status_occurred_idx" ON "internal_payment_records" USING btree ("organization_id","status","occurred_at");--> statement-breakpoint
CREATE INDEX "internal_records_org_provider_txn_idx" ON "internal_payment_records" USING btree ("organization_id","provider_transaction_id");--> statement-breakpoint
CREATE INDEX "internal_records_org_customer_idx" ON "internal_payment_records" USING btree ("organization_id","customer_id");--> statement-breakpoint
CREATE UNIQUE INDEX "mapping_templates_org_name_uidx" ON "mapping_templates" USING btree ("organization_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "usage_counters_org_period_metric_uidx" ON "usage_counters" USING btree ("organization_id","period","metric");--> statement-breakpoint
CREATE INDEX "exception_events_exception_idx" ON "exception_events" USING btree ("exception_id","created_at");--> statement-breakpoint
CREATE INDEX "exception_events_org_idx" ON "exception_events" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "exceptions_org_fingerprint_uidx" ON "exceptions" USING btree ("organization_id","fingerprint");--> statement-breakpoint
CREATE INDEX "exceptions_org_state_severity_idx" ON "exceptions" USING btree ("organization_id","state","severity");--> statement-breakpoint
CREATE INDEX "exceptions_org_rule_idx" ON "exceptions" USING btree ("organization_id","rule_id");--> statement-breakpoint
CREATE INDEX "exceptions_org_assignee_idx" ON "exceptions" USING btree ("organization_id","assigned_to_user_id");--> statement-breakpoint
CREATE INDEX "exceptions_org_created_idx" ON "exceptions" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE INDEX "exceptions_org_currency_risk_idx" ON "exceptions" USING btree ("organization_id","currency","revenue_at_risk_minor");--> statement-breakpoint
CREATE INDEX "reconciliation_runs_org_created_idx" ON "reconciliation_runs" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE INDEX "reconciliation_runs_org_status_idx" ON "reconciliation_runs" USING btree ("organization_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "notification_deliveries_org_dedupe_uidx" ON "notification_deliveries" USING btree ("organization_id","dedupe_key");--> statement-breakpoint
CREATE INDEX "notification_deliveries_status_scheduled_idx" ON "notification_deliveries" USING btree ("status","scheduled_for");--> statement-breakpoint
CREATE INDEX "notification_deliveries_org_idx" ON "notification_deliveries" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "notification_delivery_items_uidx" ON "notification_delivery_items" USING btree ("delivery_id","exception_id");--> statement-breakpoint
CREATE INDEX "notification_delivery_items_exception_idx" ON "notification_delivery_items" USING btree ("exception_id");--> statement-breakpoint
CREATE INDEX "notification_destinations_org_idx" ON "notification_destinations" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "notification_destinations_org_name_uidx" ON "notification_destinations" USING btree ("organization_id","name");--> statement-breakpoint
CREATE INDEX "notification_policies_org_idx" ON "notification_policies" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "notification_policies_destination_idx" ON "notification_policies" USING btree ("destination_id");--> statement-breakpoint
CREATE UNIQUE INDEX "billing_customers_org_uidx" ON "billing_customers" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "billing_customers_stripe_uidx" ON "billing_customers" USING btree ("stripe_customer_id");--> statement-breakpoint
CREATE UNIQUE INDEX "billing_subscriptions_stripe_uidx" ON "billing_subscriptions" USING btree ("stripe_subscription_id");--> statement-breakpoint
CREATE INDEX "billing_subscriptions_org_idx" ON "billing_subscriptions" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "billing_webhook_events_stripe_uidx" ON "billing_webhook_events" USING btree ("stripe_event_id");--> statement-breakpoint
CREATE INDEX "billing_webhook_events_status_idx" ON "billing_webhook_events" USING btree ("status");--> statement-breakpoint
CREATE INDEX "audit_events_org_created_idx" ON "audit_events" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE INDEX "audit_events_org_action_idx" ON "audit_events" USING btree ("organization_id","action");--> statement-breakpoint
CREATE INDEX "audit_events_actor_idx" ON "audit_events" USING btree ("actor_user_id");--> statement-breakpoint
CREATE INDEX "audit_events_correlation_idx" ON "audit_events" USING btree ("correlation_id");