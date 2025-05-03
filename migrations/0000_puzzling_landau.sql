CREATE TABLE "chat_exports" (
	"id" serial PRIMARY KEY NOT NULL,
	"original_filename" text NOT NULL,
	"file_hash" text NOT NULL,
	"participants" text[],
	"generated_at" timestamp DEFAULT now() NOT NULL,
	"pdf_url" text,
	"processing_options" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "media_files" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" text NOT NULL,
	"chat_export_id" integer NOT NULL,
	"message_id" integer,
	"original_name" text NOT NULL,
	"content_type" text NOT NULL,
	"size" integer NOT NULL,
	"uploaded_at" timestamp DEFAULT now() NOT NULL,
	"url" text,
	"type" text DEFAULT 'attachment' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" serial PRIMARY KEY NOT NULL,
	"chat_export_id" integer NOT NULL,
	"timestamp" timestamp NOT NULL,
	"sender" text NOT NULL,
	"content" text NOT NULL,
	"type" text DEFAULT 'text' NOT NULL,
	"media_url" text,
	"duration" integer,
	"is_deleted" boolean DEFAULT false
);
--> statement-breakpoint
CREATE TABLE "processing_progress" (
	"client_id" text PRIMARY KEY NOT NULL,
	"progress" integer DEFAULT 0 NOT NULL,
	"step" integer,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
