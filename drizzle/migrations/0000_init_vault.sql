CREATE TYPE "public"."audit_category" AS ENUM('read', 'write', 'update', 'delete');--> statement-breakpoint
CREATE TYPE "public"."qbo_connection_status" AS ENUM('active', 'revoked', 'error');--> statement-breakpoint
CREATE TYPE "public"."qbo_environment" AS ENUM('sandbox', 'production');--> statement-breakpoint
CREATE TABLE "audit_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid,
	"realm_id" text,
	"tool_name" text NOT NULL,
	"category" "audit_category" NOT NULL,
	"success" boolean NOT NULL,
	"error_message" text,
	"duration_ms" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "quickbooks_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"realm_id" text NOT NULL,
	"enc_refresh_token" text NOT NULL,
	"enc_access_token" text,
	"access_token_expires_at" timestamp with time zone,
	"refresh_token_expires_at" timestamp with time zone NOT NULL,
	"environment" "qbo_environment" DEFAULT 'sandbox' NOT NULL,
	"status" "qbo_connection_status" DEFAULT 'active' NOT NULL,
	"last_refreshed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tenants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workos_user_id" text NOT NULL,
	"workos_org_id" text NOT NULL,
	"email" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quickbooks_connections" ADD CONSTRAINT "quickbooks_connections_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_logs_tenant_created_idx" ON "audit_logs" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "qbo_conn_tenant_realm_uq" ON "quickbooks_connections" USING btree ("tenant_id","realm_id");--> statement-breakpoint
CREATE UNIQUE INDEX "qbo_conn_one_active_per_tenant_uq" ON "quickbooks_connections" USING btree ("tenant_id") WHERE "quickbooks_connections"."status" = 'active';--> statement-breakpoint
CREATE INDEX "qbo_conn_access_expiry_idx" ON "quickbooks_connections" USING btree ("access_token_expires_at") WHERE "quickbooks_connections"."status" = 'active';--> statement-breakpoint
CREATE INDEX "qbo_conn_refresh_expiry_idx" ON "quickbooks_connections" USING btree ("refresh_token_expires_at") WHERE "quickbooks_connections"."status" = 'active';--> statement-breakpoint
CREATE UNIQUE INDEX "tenants_workos_user_org_uq" ON "tenants" USING btree ("workos_user_id","workos_org_id");--> statement-breakpoint
CREATE INDEX "tenants_workos_user_idx" ON "tenants" USING btree ("workos_user_id");