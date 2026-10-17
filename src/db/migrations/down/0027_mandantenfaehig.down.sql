-- Down path for 0027_mandantenfaehig.sql (issue #1200, ADR-0031).
--
-- **Bricht ab, wenn mehr als ein Konto existiert.** Ohne `user_id` gibt es keine
-- Trennung mehr; die Zeilen von N Menschen lägen danach in einem Topf, und
-- genau die festen Zeilen-IDs (JOURNAL_HABIT_ID, JOURNAL_KEYS_ROW_ID), wegen
-- derer der Primärschlüssel zusammengesetzt wurde, würden beim Wiederherstellen
-- des Einzelspalten-PK kollidieren. Lieber laut scheitern als still Daten
-- zusammenwerfen.
--
-- Wie jedes Down-Skript von Hand angewendet (ARCHITECTURE.md) — nichts führt es
-- automatisch aus.
DO $$
BEGIN
  IF (SELECT count(*) FROM "users") > 1 THEN
    RAISE EXCEPTION
      'Rückweg verweigert: % Konten vorhanden. Ohne user_id gäbe es keine Trennung mehr.',
      (SELECT count(*) FROM "users");
  END IF;
END $$;
--> statement-breakpoint

-- 1. Zusammengesetzte Fremdschlüssel zurück auf die einspaltigen.
ALTER TABLE "event_exceptions" DROP CONSTRAINT "event_exceptions_event_fk";--> statement-breakpoint
ALTER TABLE "habit_freezes" DROP CONSTRAINT "habit_freezes_habit_fk";--> statement-breakpoint
ALTER TABLE "habit_logs" DROP CONSTRAINT "habit_logs_habit_fk";--> statement-breakpoint
ALTER TABLE "tasks" DROP CONSTRAINT "tasks_parent_fk";--> statement-breakpoint

-- 2. Zusammengesetzte Primärschlüssel zurück auf `id` allein.
ALTER TABLE "sync_state" DROP CONSTRAINT "sync_state_user_id_id_pk";--> statement-breakpoint
ALTER TABLE "sync_state" ADD CONSTRAINT "sync_state_pkey" PRIMARY KEY("id");--> statement-breakpoint
ALTER TABLE "tasks" DROP CONSTRAINT "tasks_user_id_id_pk";--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_pkey" PRIMARY KEY("id");--> statement-breakpoint
ALTER TABLE "habits" DROP CONSTRAINT "habits_user_id_id_pk";--> statement-breakpoint
ALTER TABLE "habits" ADD CONSTRAINT "habits_pkey" PRIMARY KEY("id");--> statement-breakpoint
ALTER TABLE "habit_logs" DROP CONSTRAINT "habit_logs_user_id_id_pk";--> statement-breakpoint
ALTER TABLE "habit_logs" ADD CONSTRAINT "habit_logs_pkey" PRIMARY KEY("id");--> statement-breakpoint
ALTER TABLE "habit_freezes" DROP CONSTRAINT "habit_freezes_user_id_id_pk";--> statement-breakpoint
ALTER TABLE "habit_freezes" ADD CONSTRAINT "habit_freezes_pkey" PRIMARY KEY("id");--> statement-breakpoint
ALTER TABLE "reminder_prefs" DROP CONSTRAINT "reminder_prefs_user_id_id_pk";--> statement-breakpoint
ALTER TABLE "reminder_prefs" ADD CONSTRAINT "reminder_prefs_pkey" PRIMARY KEY("id");--> statement-breakpoint
ALTER TABLE "category_colors" DROP CONSTRAINT "category_colors_user_id_id_pk";--> statement-breakpoint
ALTER TABLE "category_colors" ADD CONSTRAINT "category_colors_pkey" PRIMARY KEY("id");--> statement-breakpoint
ALTER TABLE "journal_entries" DROP CONSTRAINT "journal_entries_user_id_id_pk";--> statement-breakpoint
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_pkey" PRIMARY KEY("id");--> statement-breakpoint
ALTER TABLE "journal_keys" DROP CONSTRAINT "journal_keys_user_id_id_pk";--> statement-breakpoint
ALTER TABLE "journal_keys" ADD CONSTRAINT "journal_keys_pkey" PRIMARY KEY("id");--> statement-breakpoint
ALTER TABLE "events" DROP CONSTRAINT "events_user_id_id_pk";--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_pkey" PRIMARY KEY("id");--> statement-breakpoint
ALTER TABLE "event_exceptions" DROP CONSTRAINT "event_exceptions_user_id_id_pk";--> statement-breakpoint
ALTER TABLE "event_exceptions" ADD CONSTRAINT "event_exceptions_pkey" PRIMARY KEY("id");--> statement-breakpoint

ALTER TABLE "event_exceptions" ADD CONSTRAINT "event_exceptions_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "habit_freezes" ADD CONSTRAINT "habit_freezes_habit_id_habits_id_fk" FOREIGN KEY ("habit_id") REFERENCES "public"."habits"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "habit_logs" ADD CONSTRAINT "habit_logs_habit_id_habits_id_fk" FOREIGN KEY ("habit_id") REFERENCES "public"."habits"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_parent_id_tasks_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint

-- 3. Eindeutige Indizes zurück auf die globale Form.
DROP INDEX "sync_state_user_id_key_idx";--> statement-breakpoint
DROP INDEX "category_colors_user_id_category_idx";--> statement-breakpoint
DROP INDEX "event_exceptions_user_id_event_id_original_date_idx";--> statement-breakpoint
DROP INDEX "habit_freezes_user_id_habit_id_freeze_date_idx";--> statement-breakpoint
DROP INDEX "habit_logs_user_id_habit_id_log_date_idx";--> statement-breakpoint
DROP INDEX "reminder_prefs_user_id_kind_idx";--> statement-breakpoint
DROP INDEX "reminder_sends_user_id_kind_send_date_slot_idx";--> statement-breakpoint
DROP INDEX "push_subscriptions_user_id_endpoint_idx";--> statement-breakpoint
DROP INDEX "push_subscriptions_user_id_idx";--> statement-breakpoint
DROP INDEX "sessions_user_id_idx";--> statement-breakpoint
ALTER TABLE "sync_state" ADD CONSTRAINT "sync_state_key_unique" UNIQUE("key");--> statement-breakpoint
ALTER TABLE "push_subscriptions" ADD CONSTRAINT "push_subscriptions_endpoint_unique" UNIQUE("endpoint");--> statement-breakpoint
CREATE UNIQUE INDEX "category_colors_category_idx" ON "category_colors" USING btree ("category");--> statement-breakpoint
CREATE UNIQUE INDEX "event_exceptions_event_id_original_date_idx" ON "event_exceptions" USING btree ("event_id","original_date");--> statement-breakpoint
CREATE UNIQUE INDEX "habit_freezes_habit_id_freeze_date_idx" ON "habit_freezes" USING btree ("habit_id","freeze_date");--> statement-breakpoint
CREATE UNIQUE INDEX "habit_logs_habit_id_log_date_idx" ON "habit_logs" USING btree ("habit_id","log_date");--> statement-breakpoint
CREATE UNIQUE INDEX "reminder_prefs_kind_idx" ON "reminder_prefs" USING btree ("kind");--> statement-breakpoint
CREATE UNIQUE INDEX "reminder_sends_kind_send_date_slot_idx" ON "reminder_sends" USING btree ("kind","send_date","slot");--> statement-breakpoint

-- 4. user_id und users weg. Die Spalten fallen mit ihren FKs; `users` zuletzt.
ALTER TABLE "auth_challenges" DROP COLUMN "user_id";--> statement-breakpoint
ALTER TABLE "sync_state" DROP COLUMN "user_id";--> statement-breakpoint
ALTER TABLE "tasks" DROP COLUMN "user_id";--> statement-breakpoint
ALTER TABLE "habits" DROP COLUMN "user_id";--> statement-breakpoint
ALTER TABLE "habit_logs" DROP COLUMN "user_id";--> statement-breakpoint
ALTER TABLE "habit_freezes" DROP COLUMN "user_id";--> statement-breakpoint
ALTER TABLE "reminder_prefs" DROP COLUMN "user_id";--> statement-breakpoint
ALTER TABLE "category_colors" DROP COLUMN "user_id";--> statement-breakpoint
ALTER TABLE "journal_entries" DROP COLUMN "user_id";--> statement-breakpoint
ALTER TABLE "journal_keys" DROP COLUMN "user_id";--> statement-breakpoint
ALTER TABLE "events" DROP COLUMN "user_id";--> statement-breakpoint
ALTER TABLE "event_exceptions" DROP COLUMN "user_id";--> statement-breakpoint
ALTER TABLE "credentials" DROP COLUMN "user_id";--> statement-breakpoint
ALTER TABLE "sessions" DROP COLUMN "user_id";--> statement-breakpoint
ALTER TABLE "recovery_codes" DROP COLUMN "user_id";--> statement-breakpoint
ALTER TABLE "push_subscriptions" DROP COLUMN "user_id";--> statement-breakpoint
ALTER TABLE "reminder_sends" DROP COLUMN "user_id";--> statement-breakpoint
DROP TABLE "users";
