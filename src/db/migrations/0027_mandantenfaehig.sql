-- #1200 / ADR-0031: aus einer Ein-Personen-Datenbank wird eine mandantenfähige.
--
-- Von Hand sequenziert, nicht so übernommen, wie `drizzle-kit generate` es
-- ausgibt. Der Generator kennt nur den Zielzustand und schreibt deshalb
-- `ADD COLUMN "user_id" uuid NOT NULL` — gegen eine Tabelle mit Zeilen scheitert
-- das sofort. Nötig ist: Spalte nullable anlegen, bestehende Zeilen auf das
-- Bootstrap-Konto umhängen, erst dann NOT NULL.
--
-- Der Endzustand ist identisch mit dem generierten (tests/schema.spec.ts hält
-- Migrationen gegen src/db/schema.ts); nur der Weg dorthin ist ein anderer.

CREATE TABLE "users" (
	"id" uuid PRIMARY KEY NOT NULL,
	"role" text DEFAULT 'user' NOT NULL,
	"display_name" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"blocked_at" timestamp with time zone,
	"last_seen_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX "users_role_idx" ON "users" USING btree ("role");
--> statement-breakpoint

-- 1. user_id überall nullable anlegen. `auth_challenges.user_id` bleibt
--    dauerhaft nullable: eine Erst-Einrichtung hat noch kein Konto.
ALTER TABLE "auth_challenges" ADD COLUMN "user_id" uuid;
--> statement-breakpoint
ALTER TABLE "sync_state" ADD COLUMN "user_id" uuid;
--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "user_id" uuid;
--> statement-breakpoint
ALTER TABLE "habits" ADD COLUMN "user_id" uuid;
--> statement-breakpoint
ALTER TABLE "habit_logs" ADD COLUMN "user_id" uuid;
--> statement-breakpoint
ALTER TABLE "habit_freezes" ADD COLUMN "user_id" uuid;
--> statement-breakpoint
ALTER TABLE "reminder_prefs" ADD COLUMN "user_id" uuid;
--> statement-breakpoint
ALTER TABLE "category_colors" ADD COLUMN "user_id" uuid;
--> statement-breakpoint
ALTER TABLE "journal_entries" ADD COLUMN "user_id" uuid;
--> statement-breakpoint
ALTER TABLE "journal_keys" ADD COLUMN "user_id" uuid;
--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN "user_id" uuid;
--> statement-breakpoint
ALTER TABLE "event_exceptions" ADD COLUMN "user_id" uuid;
--> statement-breakpoint
ALTER TABLE "credentials" ADD COLUMN "user_id" uuid;
--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "user_id" uuid;
--> statement-breakpoint
ALTER TABLE "recovery_codes" ADD COLUMN "user_id" uuid;
--> statement-breakpoint
ALTER TABLE "push_subscriptions" ADD COLUMN "user_id" uuid;
--> statement-breakpoint
ALTER TABLE "reminder_sends" ADD COLUMN "user_id" uuid;
--> statement-breakpoint

-- 2. Das Bootstrap-Konto. Es entsteht **nur**, wenn es etwas zu besitzen gibt:
--    eine frische Datenbank (CI, neuer Entwicklerrechner) bekommt keins, damit
--    die Erst-Einrichtung weiterhin selbst das erste Admin-Konto anlegt
--    (register/verify) statt ein leeres vorzufinden.
--
--    Alles Bestehende gehört genau einer Person — der bisherigen Einzelnutzerin —
--    also ist eine Zeile korrekt und `admin` die richtige Rolle. Die id wird
--    erzeugt, nicht aus `OWNER_USER_ID` übernommen: Migrationen lesen keine
--    Umgebung, und die Variable entfällt mit diesem Ticket ohnehin.
DO $$
DECLARE bootstrap uuid;
BEGIN
  IF EXISTS (SELECT 1 FROM "sync_state")
       OR EXISTS (SELECT 1 FROM "tasks")
       OR EXISTS (SELECT 1 FROM "habits")
       OR EXISTS (SELECT 1 FROM "habit_logs")
       OR EXISTS (SELECT 1 FROM "habit_freezes")
       OR EXISTS (SELECT 1 FROM "reminder_prefs")
       OR EXISTS (SELECT 1 FROM "category_colors")
       OR EXISTS (SELECT 1 FROM "journal_entries")
       OR EXISTS (SELECT 1 FROM "journal_keys")
       OR EXISTS (SELECT 1 FROM "events")
       OR EXISTS (SELECT 1 FROM "event_exceptions")
       OR EXISTS (SELECT 1 FROM "credentials")
       OR EXISTS (SELECT 1 FROM "sessions")
       OR EXISTS (SELECT 1 FROM "recovery_codes")
       OR EXISTS (SELECT 1 FROM "push_subscriptions")
       OR EXISTS (SELECT 1 FROM "reminder_sends") THEN
    bootstrap := gen_random_uuid();
    INSERT INTO "users" ("id", "role", "display_name") VALUES (bootstrap, 'admin', 'Bootstrap');
    UPDATE "sync_state" SET "user_id" = bootstrap WHERE "user_id" IS NULL;
    UPDATE "tasks" SET "user_id" = bootstrap WHERE "user_id" IS NULL;
    UPDATE "habits" SET "user_id" = bootstrap WHERE "user_id" IS NULL;
    UPDATE "habit_logs" SET "user_id" = bootstrap WHERE "user_id" IS NULL;
    UPDATE "habit_freezes" SET "user_id" = bootstrap WHERE "user_id" IS NULL;
    UPDATE "reminder_prefs" SET "user_id" = bootstrap WHERE "user_id" IS NULL;
    UPDATE "category_colors" SET "user_id" = bootstrap WHERE "user_id" IS NULL;
    UPDATE "journal_entries" SET "user_id" = bootstrap WHERE "user_id" IS NULL;
    UPDATE "journal_keys" SET "user_id" = bootstrap WHERE "user_id" IS NULL;
    UPDATE "events" SET "user_id" = bootstrap WHERE "user_id" IS NULL;
    UPDATE "event_exceptions" SET "user_id" = bootstrap WHERE "user_id" IS NULL;
    UPDATE "credentials" SET "user_id" = bootstrap WHERE "user_id" IS NULL;
    UPDATE "sessions" SET "user_id" = bootstrap WHERE "user_id" IS NULL;
    UPDATE "recovery_codes" SET "user_id" = bootstrap WHERE "user_id" IS NULL;
    UPDATE "push_subscriptions" SET "user_id" = bootstrap WHERE "user_id" IS NULL;
    UPDATE "reminder_sends" SET "user_id" = bootstrap WHERE "user_id" IS NULL;
  END IF;
END $$;
--> statement-breakpoint

-- 3. Jetzt erst NOT NULL. Schlägt das fehl, stehen Zeilen ohne Konto in der
--    Datenbank — dann ist ein Mensch gefragt, nicht ein stiller Default.
ALTER TABLE "sync_state" ALTER COLUMN "user_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "tasks" ALTER COLUMN "user_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "habits" ALTER COLUMN "user_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "habit_logs" ALTER COLUMN "user_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "habit_freezes" ALTER COLUMN "user_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "reminder_prefs" ALTER COLUMN "user_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "category_colors" ALTER COLUMN "user_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "journal_entries" ALTER COLUMN "user_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "journal_keys" ALTER COLUMN "user_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "events" ALTER COLUMN "user_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "event_exceptions" ALTER COLUMN "user_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "credentials" ALTER COLUMN "user_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "sessions" ALTER COLUMN "user_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "recovery_codes" ALTER COLUMN "user_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "push_subscriptions" ALTER COLUMN "user_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "reminder_sends" ALTER COLUMN "user_id" SET NOT NULL;
--> statement-breakpoint

-- 4. Die alten einspaltigen Fremdschlüssel **vor** den Primärschlüsseln lösen:
--    sie hängen am `<tabelle>_pkey`-Index, und ein DROP CONSTRAINT auf den PK
--    scheitert sonst mit "other objects depend on it". Die zusammengesetzten
--    Nachfolger kommen in Schritt 6, sobald die neuen PKs stehen.
ALTER TABLE "event_exceptions" DROP CONSTRAINT "event_exceptions_event_id_events_id_fk";
--> statement-breakpoint
ALTER TABLE "habit_freezes" DROP CONSTRAINT "habit_freezes_habit_id_habits_id_fk";
--> statement-breakpoint
ALTER TABLE "habit_logs" DROP CONSTRAINT "habit_logs_habit_id_habits_id_fk";
--> statement-breakpoint
ALTER TABLE "tasks" DROP CONSTRAINT "tasks_parent_id_tasks_id_fk";
--> statement-breakpoint

-- 5. Alte Einzelspalten-Primärschlüssel weg, zusammengesetzte rein. Der
--    Generator kann den Namen des alten PK nicht ermitteln; in Postgres ist es
--    der Default `<tabelle>_pkey`, weil er über `uuid('id').primaryKey()`
--    inline entstanden ist.
ALTER TABLE "sync_state" DROP CONSTRAINT "sync_state_pkey";
--> statement-breakpoint
ALTER TABLE "sync_state" ADD CONSTRAINT "sync_state_user_id_id_pk" PRIMARY KEY("user_id","id");
--> statement-breakpoint
ALTER TABLE "tasks" DROP CONSTRAINT "tasks_pkey";
--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_user_id_id_pk" PRIMARY KEY("user_id","id");
--> statement-breakpoint
ALTER TABLE "habits" DROP CONSTRAINT "habits_pkey";
--> statement-breakpoint
ALTER TABLE "habits" ADD CONSTRAINT "habits_user_id_id_pk" PRIMARY KEY("user_id","id");
--> statement-breakpoint
ALTER TABLE "habit_logs" DROP CONSTRAINT "habit_logs_pkey";
--> statement-breakpoint
ALTER TABLE "habit_logs" ADD CONSTRAINT "habit_logs_user_id_id_pk" PRIMARY KEY("user_id","id");
--> statement-breakpoint
ALTER TABLE "habit_freezes" DROP CONSTRAINT "habit_freezes_pkey";
--> statement-breakpoint
ALTER TABLE "habit_freezes" ADD CONSTRAINT "habit_freezes_user_id_id_pk" PRIMARY KEY("user_id","id");
--> statement-breakpoint
ALTER TABLE "reminder_prefs" DROP CONSTRAINT "reminder_prefs_pkey";
--> statement-breakpoint
ALTER TABLE "reminder_prefs" ADD CONSTRAINT "reminder_prefs_user_id_id_pk" PRIMARY KEY("user_id","id");
--> statement-breakpoint
ALTER TABLE "category_colors" DROP CONSTRAINT "category_colors_pkey";
--> statement-breakpoint
ALTER TABLE "category_colors" ADD CONSTRAINT "category_colors_user_id_id_pk" PRIMARY KEY("user_id","id");
--> statement-breakpoint
ALTER TABLE "journal_entries" DROP CONSTRAINT "journal_entries_pkey";
--> statement-breakpoint
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_user_id_id_pk" PRIMARY KEY("user_id","id");
--> statement-breakpoint
ALTER TABLE "journal_keys" DROP CONSTRAINT "journal_keys_pkey";
--> statement-breakpoint
ALTER TABLE "journal_keys" ADD CONSTRAINT "journal_keys_user_id_id_pk" PRIMARY KEY("user_id","id");
--> statement-breakpoint
ALTER TABLE "events" DROP CONSTRAINT "events_pkey";
--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_user_id_id_pk" PRIMARY KEY("user_id","id");
--> statement-breakpoint
ALTER TABLE "event_exceptions" DROP CONSTRAINT "event_exceptions_pkey";
--> statement-breakpoint
ALTER TABLE "event_exceptions" ADD CONSTRAINT "event_exceptions_user_id_id_pk" PRIMARY KEY("user_id","id");
--> statement-breakpoint

-- 6a. Fremdschlüssel auf `users` (ON DELETE CASCADE — ein gelöschtes Konto nimmt
--    jede seiner Zeilen mit, das ist der einzige harte Delete im Datenmodell).
ALTER TABLE "auth_challenges" ADD CONSTRAINT "auth_challenges_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "sync_state" ADD CONSTRAINT "sync_state_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "habits" ADD CONSTRAINT "habits_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "habit_logs" ADD CONSTRAINT "habit_logs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "habit_freezes" ADD CONSTRAINT "habit_freezes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "reminder_prefs" ADD CONSTRAINT "reminder_prefs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "category_colors" ADD CONSTRAINT "category_colors_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "journal_keys" ADD CONSTRAINT "journal_keys_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "event_exceptions" ADD CONSTRAINT "event_exceptions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "credentials" ADD CONSTRAINT "credentials_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "recovery_codes" ADD CONSTRAINT "recovery_codes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "push_subscriptions" ADD CONSTRAINT "push_subscriptions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "reminder_sends" ADD CONSTRAINT "reminder_sends_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint

-- 6b. Die Referenzen *zwischen* synchronisierten Tabellen, jetzt zusammengesetzt.
--     Das ist der eigentliche Riegel: eine Zeile, die auf eine Zeile eines
--     fremden Kontos zeigt, scheitert ab hier an der Datenbank, nicht an einer
--     Prüfung im Code (ADR-0031).
ALTER TABLE "event_exceptions" ADD CONSTRAINT "event_exceptions_event_fk" FOREIGN KEY ("user_id","event_id") REFERENCES "public"."events"("user_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "habit_freezes" ADD CONSTRAINT "habit_freezes_habit_fk" FOREIGN KEY ("user_id","habit_id") REFERENCES "public"."habits"("user_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "habit_logs" ADD CONSTRAINT "habit_logs_habit_fk" FOREIGN KEY ("user_id","habit_id") REFERENCES "public"."habits"("user_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_parent_fk" FOREIGN KEY ("user_id","parent_id") REFERENCES "public"."tasks"("user_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint

-- 7. Jeder bisher global eindeutige Index wird um `user_id` erweitert. Jeder
--    einzelne davon wäre sonst ein Kollisionspunkt zwischen zwei Konten.
ALTER TABLE "sync_state" DROP CONSTRAINT "sync_state_key_unique";
--> statement-breakpoint
ALTER TABLE "push_subscriptions" DROP CONSTRAINT "push_subscriptions_endpoint_unique";
--> statement-breakpoint
DROP INDEX "category_colors_category_idx";--> statement-breakpoint
DROP INDEX "event_exceptions_event_id_original_date_idx";--> statement-breakpoint
DROP INDEX "habit_freezes_habit_id_freeze_date_idx";--> statement-breakpoint
DROP INDEX "habit_logs_habit_id_log_date_idx";--> statement-breakpoint
DROP INDEX "reminder_prefs_kind_idx";--> statement-breakpoint
DROP INDEX "reminder_sends_kind_send_date_slot_idx";--> statement-breakpoint
CREATE UNIQUE INDEX "sync_state_user_id_key_idx" ON "sync_state" USING btree ("user_id","key");--> statement-breakpoint
CREATE UNIQUE INDEX "category_colors_user_id_category_idx" ON "category_colors" USING btree ("user_id","category");--> statement-breakpoint
CREATE UNIQUE INDEX "event_exceptions_user_id_event_id_original_date_idx" ON "event_exceptions" USING btree ("user_id","event_id","original_date");--> statement-breakpoint
CREATE UNIQUE INDEX "habit_freezes_user_id_habit_id_freeze_date_idx" ON "habit_freezes" USING btree ("user_id","habit_id","freeze_date");--> statement-breakpoint
CREATE UNIQUE INDEX "habit_logs_user_id_habit_id_log_date_idx" ON "habit_logs" USING btree ("user_id","habit_id","log_date");--> statement-breakpoint
CREATE UNIQUE INDEX "reminder_prefs_user_id_kind_idx" ON "reminder_prefs" USING btree ("user_id","kind");--> statement-breakpoint
CREATE UNIQUE INDEX "reminder_sends_user_id_kind_send_date_slot_idx" ON "reminder_sends" USING btree ("user_id","kind","send_date","slot");--> statement-breakpoint
CREATE UNIQUE INDEX "push_subscriptions_user_id_endpoint_idx" ON "push_subscriptions" USING btree ("user_id","endpoint");--> statement-breakpoint
CREATE INDEX "push_subscriptions_user_id_idx" ON "push_subscriptions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "sessions_user_id_idx" ON "sessions" USING btree ("user_id");
