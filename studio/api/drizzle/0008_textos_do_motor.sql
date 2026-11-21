CREATE TABLE "engine_text" (
	"key" text PRIMARY KEY NOT NULL,
	"text" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text DEFAULT 'system' NOT NULL
);
