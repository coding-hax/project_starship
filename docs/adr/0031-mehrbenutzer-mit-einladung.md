# ADR-0031: Mehrbenutzer mit Einladungs-Links, Admin als Rolle an `users`

Status: angenommen · Datum: 2026-10-17 · Bezug: Epic #1199, S1 #1200 ·
löst ADR-0011 ab, ändert `docs/VISION.md` („Für wen", Nicht-Ziele) und
`docs/ARCHITECTURE.md` („Security" → Autorisierung)

## Kontext

Starship war von der ersten Zeile an für **genau eine Person** gebaut. Das stand
so in `docs/VISION.md` („Es gibt keine anderen Nutzer, keine Rollen, keine
Rechte, keine Einladungen, keine Mandantentrennung. Das ist eine
Feature-Entscheidung, kein Zwischenstand") und hat die Architektur an vielen
Stellen vereinfacht: `requireOwner()` prüfte nur, **dass** eine Sitzung
existiert, nie **wessen**; `getSession()` gab die `OWNER_USER_ID` aus der Env
zurück, und der Vergleich dagegen war tautologisch wahr; jede synchronisierte
Zeile hatte genau einen denkbaren Eigentümer, also brauchte keine Tabelle eine
Eigentümerspalte.

Der Eigentümer möchte die App jetzt anderen Menschen zugänglich machen. Das ist
keine Vorschlagsfrage aus einem Ticket, sondern eine Produktentscheidung des
Eigentümers — der betreffende Vision-Absatz wird dadurch nicht verletzt,
sondern abgelöst.

Die Umstellung ist nicht additiv. Drei Dinge brechen beim zweiten Konto sofort
und still:

1. **Feste Primärschlüssel.** `JOURNAL_HABIT_ID` und `JOURNAL_KEYS_ROW_ID` sind
   eincodierte UUIDs (ADR-0016) und heute Primärschlüssel synchronisierter
   Tabellen. Der zweite Nutzer, dessen Client `ensureJournalHabit()` aufruft,
   schreibt auf die Zeile des ersten.
2. **Acht global eindeutige Indizes** (`sync_state.key`, `reminder_prefs.kind`,
   `category_colors.category`, `habit_logs(habit_id, log_date)`,
   `event_exceptions(event_id, original_date)`, `push_subscriptions.endpoint`,
   `reminder_sends(kind, send_date, slot)`): jeder wird zum Kollisionspunkt.
3. **Fremdschlüssel über Mandantengrenzen.** `habit_logs.habit_id` &co. zeigen
   auf eine blanke `id` — nichts hindert einen Client daran, ein Log an die
   Routine eines fremden Kontos zu hängen.

## Entscheidung

**1. Mandantentrennung über `(user_id, id)` als Primärschlüssel, nicht über
`user_id` als bloße Spalte.**

Jede synchronisierte Tabelle trägt `user_id NOT NULL REFERENCES users(id) ON
DELETE CASCADE`, und ihr Primärschlüssel ist `(user_id, id)`. Jeder
Fremdschlüssel zwischen zwei synchronisierten Tabellen wird zusammengesetzt:
`(user_id, habit_id) → habits(user_id, id)`.

Das kostet etwas Breite in jedem Index und macht im Gegenzug die beiden
gefährlichsten Fehlerklassen **strukturell unmöglich** statt nur verboten: eine
Zeile mit der `id` eines fremden Kontos ist eine eigene Zeile, kein
Überschreiben; eine Referenz über die Mandantengrenze scheitert an der
Datenbank. Die Alternative — `user_id` als gewöhnliche Spalte und ein
`WHERE user_id = …` in jeder Abfrage — verlagert dieselbe Garantie auf die
Disziplin beim Schreiben jeder einzelnen Query. In `src/app/api/sync/` ist ein
vergessenes `WHERE` kein Bug, sondern fremde Daten im falschen Konto.

Die festen Zeilen-IDs (`JOURNAL_HABIT_ID`, ADR-0016) bleiben damit gültig,
ohne je Nutzer abgeleitet werden zu müssen.

**2. Eine globale `sync_seq` bleibt, der Pull filtert.**

ADR-0008 bleibt unberührt: eine Sequenz für alle Konten. Ein Konto sieht Lücken
in der Nummernfolge, weil dazwischen ein anderes geschrieben hat — das ist
harmlos, weil der Cursor nur „höher als" vergleicht und nie „lückenlos"
voraussetzt. Eine Sequenz je Konto wäre die naheliegende Alternative und wurde
verworfen: sie bräuchte ein `CREATE SEQUENCE` je neuem Konto, also DDL zur
Laufzeit, und `pg_advisory_xact_lock` müsste je Konto gefasst werden statt
einmal global.

**3. Admin ist eine Rolle an `users`, kein zweiter Auth-Stack.**

`users.role` ist `'admin' | 'user'`. Ein Login-Pfad, ein Cookie, eine
Passkey-Zeremonie; `role = 'admin'` schaltet `/admin` frei. Die Alternative —
eigene `admins`/`admin_credentials`/`admin_sessions` und ein zweites Cookie —
isoliert stärker, verdoppelt aber die gesamte WebAuthn- und Session-Schicht.
In einem Pfad, in dem ein Fehler Datenverlust heißt, ist weniger Auth-Code das
stärkere Argument als mehr Isolation zwischen zwei Rollen, die derselbe Mensch
betreut.

**4. Registrierung gibt es nur über Einladungs-Links.**

Kein öffentliches Anmeldeformular; das Vision-Nicht-Ziel „öffentliche
Registrierung" bleibt also bestehen. Das bisherige Erst-Setup-Tor („keine
Credentials vorhanden ⇒ Registrierung offen") verschwindet mit S3: eine leere
Datenbank macht die Registrierung dann nicht mehr auf. Der erste Admin entsteht
über einen Handgriff auf der Kommandozeile.

**5. Der Admin bekommt keinen Lesezugriff auf Nutzerinhalte.**

Das Panel zeigt Zählwerte, Größen und Zeitstempel — nie einen Aufgabentitel,
einen Termin, einen Journaleintrag. Journal-Inhalte sind ohnehin unlesbar
(ADR-0004), aber auch die lesbaren Tabellen bleiben zu. Das ist ein Invariant
mit eigenem Test, keine Höflichkeit.

**6. „Passwort zurücksetzen" gibt es nicht.**

Es gibt keine Passwörter. Was der Admin kann: alle Passkeys und Sitzungen eines
Kontos widerrufen und einen frischen Einladungs-Link ausstellen — die Daten
bleiben. Was der Admin **nicht** kann: die Journal-Passphrase zurücksetzen. Der
Server kennt den Klartext nie (ADR-0004), also kennt ihn auch der Admin nicht.
Das einzige Werkzeug bei verlorener Passphrase ist „Journal löschen", hart und
doppelt bestätigt (ein Soft-Delete heilt sich über den Sync von einem Gerät aus
wieder).

**7. Garmin fällt ersatzlos weg.**

Das Modul hing an einem globalen OAuth1/2-Tokenpaar und einem Cron, der genau
ein Konto kannte. Es wird nicht gebraucht und wäre der aufwendigste Teil der
Mandantenfähigkeit. Damit ist ADR-0011 abgelöst und `garmin_activities` als
einzige read-only Server-Origin-Tabelle verschwunden.

## Folgen

- `OWNER_USER_ID` entfällt. `requireUser()` liest die `user_id` aus der
  Sitzungszeile und liefert `{ userId, role, credentialId }`; ohne Sitzung
  `401`, bei gesetztem `users.blocked_at` `403 blocked`. Der Client kann die
  beiden Fälle unterscheiden und muss das auch (S2).
- `scripts/check-tenant-isolation.sh` wird Required Check: eine synchronisierte
  Tabelle ohne `(user_id, id)`-Primärschlüssel, ein übriggebliebenes
  `requireOwner`/`OWNER_USER_ID` oder eine API-Route, die `@/db` ohne
  `requireUser` importiert, machen CI rot. Der Wächter ersetzt keine Sorgfalt,
  er fängt die Wiederholung.
- **Die Dexie-Datenbank ist an den Origin gebunden, nicht ans Konto.** Bis S2
  landet, sähe ein zweiter Mensch am selben Browser die Daten des ersten. S2
  steht deshalb zwingend vor S3 (Einladungen) — vorher kann es faktisch nur das
  eine Bootstrap-Konto geben.
- Mit dem zweiten Konto werden aus „meinen Daten" fremde personenbezogene
  Daten, und das Repo ist öffentlich. Impressum, Datenschutzerklärung und
  Löschkonzept sind vor dem ersten fremden Konto fällig. Kein Code-Ticket, aber
  im Epic #1199 vermerkt.
- Journal-Verschlüsselung bleibt unverändert: eine Hülle je Konto, abgeleitet
  aus der Passphrase dieses Menschen (ADR-0004/-0015). Mehrbenutzer ändert am
  Krypto-Modell nichts — es gibt nur mehr Hüllen.

## Verworfene Alternativen

- **Schema je Nutzer** (`CREATE SCHEMA user_<id>`): perfekte Isolation, aber
  DDL zur Laufzeit, N× Migrationen bei jedem Schema-Schritt, und Drizzle müsste
  je Anfrage gegen ein anderes Schema gebunden werden. Für eine Handvoll
  Menschen ein unverhältnismäßiger Betriebsaufwand.
- **Row Level Security in Postgres**: wäre der sauberste Riegel, braucht aber
  eine DB-Rolle je Anfrage oder `SET LOCAL app.user_id` auf jedem
  Verbindungs-Checkout. Mit einem pg-Pool hinter Serverless-Funktionen ist ein
  vergessenes `SET` genauso tödlich wie ein vergessenes `WHERE` — nur schwerer
  zu sehen. Bleibt als spätere Härtung denkbar, zusätzlich zum zusammengesetzten
  Primärschlüssel, nicht statt seiner.
- **Mehrere Datenbanken**: löst die Trennung, macht aber den Admin-Bereich
  (Kennzahlen über alle Konten) zu einem Fan-out über N Verbindungen und
  widerspricht „0 € laufende Kosten".
