ALTER TABLE "mcp_server" ADD COLUMN "transport" text DEFAULT 'http' NOT NULL;--> statement-breakpoint
ALTER TABLE "mcp_server" ADD COLUMN "headers_enc" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "mcp_server" ADD COLUMN "origin" text DEFAULT 'custom' NOT NULL;--> statement-breakpoint
ALTER TABLE "mcp_server" ADD COLUMN "last_error" text;--> statement-breakpoint
ALTER TABLE "mcp_server" ADD COLUMN "checked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "mcp_server" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "skill" ADD COLUMN "enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "skill" ADD COLUMN "llm_tool" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "skill" ADD COLUMN "instructions" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "skill" ADD COLUMN "config" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "skill" ADD COLUMN "secret_enc" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "skill" ADD COLUMN "defaults" jsonb;--> statement-breakpoint
ALTER TABLE "skill" ADD COLUMN "source" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "skill" ADD COLUMN "version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "skill" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;
