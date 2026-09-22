CREATE TABLE "app_session" (
	"sid" text PRIMARY KEY NOT NULL,
	"data" jsonb NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app_user" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"password_hash" text NOT NULL,
	"role" text DEFAULT 'operador' NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "app_user_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor_id" uuid,
	"actor_email" text DEFAULT 'system' NOT NULL,
	"action" text NOT NULL,
	"entity" text NOT NULL,
	"entity_id" text,
	"before" jsonb,
	"after" jsonb,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "session" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"title" text DEFAULT 'Nova conversa' NOT NULL,
	"user_id" uuid,
	"flow_id" uuid,
	"use_production" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "eval_batch" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"flow_ids" jsonb NOT NULL,
	"questions" jsonb NOT NULL,
	"results" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"error" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "file" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid,
	"run_id" uuid,
	"direction" text NOT NULL,
	"name" text NOT NULL,
	"mime" text NOT NULL,
	"size" bigint NOT NULL,
	"sha256" text NOT NULL,
	"path" text NOT NULL,
	"extracted_text" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "flow" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"graph" jsonb NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "flow_release" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"flow_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"graph" jsonb NOT NULL,
	"published_by" uuid,
	"published_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mcp_server" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"url" text NOT NULL,
	"auth_mode" text DEFAULT 'none' NOT NULL,
	"tools_cache" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"description" text DEFAULT '' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "message" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"role" text NOT NULL,
	"content" text NOT NULL,
	"payload" jsonb,
	"attachments" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"run_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "model" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider_id" uuid NOT NULL,
	"model_id" text NOT NULL,
	"label" text NOT NULL,
	"purpose" text NOT NULL,
	"price_in_per_1m" double precision DEFAULT 0 NOT NULL,
	"price_out_per_1m" double precision DEFAULT 0 NOT NULL,
	"price_cache_per_1m" double precision DEFAULT 0 NOT NULL,
	"context_window" integer DEFAULT 0 NOT NULL,
	"supports_tools" boolean DEFAULT true NOT NULL,
	"supports_json" boolean DEFAULT true NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "production" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"flow_release_id" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "provider" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"base_url" text DEFAULT '' NOT NULL,
	"api_key_enc" text DEFAULT '' NOT NULL,
	"api_key_tail" text DEFAULT '' NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "run" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"flow_id" uuid,
	"flow_name" text DEFAULT '' NOT NULL,
	"flow_revision" integer NOT NULL,
	"flow_release_id" uuid,
	"graph" jsonb NOT NULL,
	"is_production" boolean DEFAULT false NOT NULL,
	"session_id" uuid,
	"user_id" uuid,
	"question" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"error" text,
	"outcome" jsonb,
	"rating" integer,
	"rating_comment" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	"cost_usd" double precision DEFAULT 0 NOT NULL,
	"tokens_in" integer DEFAULT 0 NOT NULL,
	"tokens_out" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "skill" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text NOT NULL,
	"input_schema" jsonb NOT NULL,
	"kind" text DEFAULT 'builtin' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "span" (
	"id" uuid PRIMARY KEY NOT NULL,
	"run_id" uuid NOT NULL,
	"parent_id" uuid,
	"node_id" text,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"input" jsonb,
	"output" jsonb,
	"status" text DEFAULT 'running' NOT NULL,
	"error" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ms" integer,
	"model_id" uuid,
	"tokens_in" integer DEFAULT 0 NOT NULL,
	"tokens_out" integer DEFAULT 0 NOT NULL,
	"cost_usd" double precision DEFAULT 0 NOT NULL,
	"seq" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "specialty" (
	"id" serial PRIMARY KEY NOT NULL,
	"number" integer NOT NULL,
	"name" text NOT NULL,
	"area" text DEFAULT '' NOT NULL,
	"cluster" text DEFAULT '' NOT NULL,
	"role" text DEFAULT 'specialist' NOT NULL,
	"routable" boolean DEFAULT true NOT NULL,
	"scope" text DEFAULT '' NOT NULL,
	"default_prompt" text DEFAULT '' NOT NULL,
	"default_spaces" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"default_skills" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"routing_hints" jsonb DEFAULT '{"keywords":[],"examples":[]}'::jsonb NOT NULL,
	"escalation_rules" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"phase" integer DEFAULT 1 NOT NULL,
	"zone" text DEFAULT 'verde' NOT NULL,
	CONSTRAINT "specialty_number_unique" UNIQUE("number")
);
--> statement-breakpoint
CREATE TABLE "usage" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid,
	"span_id" uuid,
	"user_id" uuid,
	"flow_id" uuid,
	"node_id" text,
	"node_name" text,
	"specialty_number" integer,
	"provider_id" uuid,
	"model_id" uuid,
	"operation" text DEFAULT 'chat' NOT NULL,
	"tokens_in" integer DEFAULT 0 NOT NULL,
	"tokens_out" integer DEFAULT 0 NOT NULL,
	"tokens_cache" integer DEFAULT 0 NOT NULL,
	"cost_usd" double precision DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_user_id_app_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_flow_id_flow_id_fk" FOREIGN KEY ("flow_id") REFERENCES "public"."flow"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eval_batch" ADD CONSTRAINT "eval_batch_created_by_app_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "file" ADD CONSTRAINT "file_session_id_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."session"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "flow" ADD CONSTRAINT "flow_created_by_app_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "flow_release" ADD CONSTRAINT "flow_release_flow_id_flow_id_fk" FOREIGN KEY ("flow_id") REFERENCES "public"."flow"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "flow_release" ADD CONSTRAINT "flow_release_published_by_app_user_id_fk" FOREIGN KEY ("published_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message" ADD CONSTRAINT "message_session_id_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."session"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message" ADD CONSTRAINT "message_run_id_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."run"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model" ADD CONSTRAINT "model_provider_id_provider_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."provider"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "production" ADD CONSTRAINT "production_flow_release_id_flow_release_id_fk" FOREIGN KEY ("flow_release_id") REFERENCES "public"."flow_release"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run" ADD CONSTRAINT "run_flow_id_flow_id_fk" FOREIGN KEY ("flow_id") REFERENCES "public"."flow"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run" ADD CONSTRAINT "run_session_id_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."session"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run" ADD CONSTRAINT "run_user_id_app_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "span" ADD CONSTRAINT "span_run_id_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."run"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage" ADD CONSTRAINT "usage_run_id_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."run"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_at_idx" ON "audit_log" USING btree ("at");--> statement-breakpoint
CREATE INDEX "message_session_idx" ON "message" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "run_started_idx" ON "run" USING btree ("started_at");--> statement-breakpoint
CREATE INDEX "run_session_idx" ON "run" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "span_run_idx" ON "span" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "usage_created_idx" ON "usage" USING btree ("created_at");