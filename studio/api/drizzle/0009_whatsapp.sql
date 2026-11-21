CREATE TABLE "whatsapp_contact" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"number_id" uuid NOT NULL,
	"jid" text NOT NULL,
	"phone" text,
	"name" text,
	"session_id" uuid,
	"pending_options" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"pending_command" text,
	"busy_run_id" uuid,
	"last_inbound_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "whatsapp_inbound" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"number_id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	"external_id" text NOT NULL,
	"kind" text NOT NULL,
	"text" text DEFAULT '' NOT NULL,
	"raw" jsonb,
	"media" jsonb,
	"status" text DEFAULT 'pending' NOT NULL,
	"run_id" uuid,
	"error" text,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "whatsapp_number" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"instance_name" text NOT NULL,
	"use_production" boolean DEFAULT true NOT NULL,
	"flow_id" uuid,
	"enabled" boolean DEFAULT true NOT NULL,
	"state" text DEFAULT 'not_created' NOT NULL,
	"qr_code" text,
	"pairing_code" text,
	"qr_updated_at" timestamp with time zone,
	"number" text,
	"profile_name" text,
	"status_reason" integer,
	"connected_at" timestamp with time zone,
	"disconnected_at" timestamp with time zone,
	"last_event_at" timestamp with time zone,
	"restart_requested_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "whatsapp_number_instance_name_unique" UNIQUE("instance_name")
);
--> statement-breakpoint
CREATE TABLE "whatsapp_outbound" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"number_id" uuid NOT NULL,
	"contact_id" uuid,
	"jid" text NOT NULL,
	"text" text DEFAULT '' NOT NULL,
	"file_id" uuid,
	"run_id" uuid,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"error" text,
	"external_id" text,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "session" ADD COLUMN "whatsapp_contact_id" uuid;--> statement-breakpoint
ALTER TABLE "whatsapp_contact" ADD CONSTRAINT "whatsapp_contact_number_id_whatsapp_number_id_fk" FOREIGN KEY ("number_id") REFERENCES "public"."whatsapp_number"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "whatsapp_contact" ADD CONSTRAINT "whatsapp_contact_session_id_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."session"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "whatsapp_inbound" ADD CONSTRAINT "whatsapp_inbound_number_id_whatsapp_number_id_fk" FOREIGN KEY ("number_id") REFERENCES "public"."whatsapp_number"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "whatsapp_inbound" ADD CONSTRAINT "whatsapp_inbound_contact_id_whatsapp_contact_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."whatsapp_contact"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "whatsapp_number" ADD CONSTRAINT "whatsapp_number_flow_id_flow_id_fk" FOREIGN KEY ("flow_id") REFERENCES "public"."flow"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "whatsapp_number" ADD CONSTRAINT "whatsapp_number_created_by_app_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "whatsapp_outbound" ADD CONSTRAINT "whatsapp_outbound_number_id_whatsapp_number_id_fk" FOREIGN KEY ("number_id") REFERENCES "public"."whatsapp_number"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "whatsapp_outbound" ADD CONSTRAINT "whatsapp_outbound_contact_id_whatsapp_contact_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."whatsapp_contact"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "whatsapp_contact_number_jid_idx" ON "whatsapp_contact" USING btree ("number_id","jid");--> statement-breakpoint
CREATE UNIQUE INDEX "whatsapp_inbound_ext_idx" ON "whatsapp_inbound" USING btree ("number_id","external_id");--> statement-breakpoint
CREATE INDEX "whatsapp_inbound_status_idx" ON "whatsapp_inbound" USING btree ("status","contact_id");--> statement-breakpoint
CREATE INDEX "whatsapp_outbound_due_idx" ON "whatsapp_outbound" USING btree ("status","next_attempt_at");