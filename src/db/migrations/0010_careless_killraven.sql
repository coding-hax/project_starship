CREATE TABLE "reminder_sends" (
	"id" uuid PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"send_date" date NOT NULL,
	"slot" text NOT NULL,
	"sent_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "reminder_sends_kind_send_date_slot_idx" ON "reminder_sends" USING btree ("kind","send_date","slot");