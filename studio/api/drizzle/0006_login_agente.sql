CREATE TABLE "agent_login" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"device_hash" text NOT NULL,
	"user_code" text NOT NULL,
	"client" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"user_id" uuid,
	"expires_in_days" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "agent_login_device_hash_unique" UNIQUE("device_hash"),
	CONSTRAINT "agent_login_user_code_unique" UNIQUE("user_code")
);
--> statement-breakpoint
ALTER TABLE "agent_login" ADD CONSTRAINT "agent_login_user_id_app_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_user"("id") ON DELETE cascade ON UPDATE no action;