# ADR-0008: Konfliktauflösung über eine server-monotone Sequence statt Client-Uhr

Status: **angenommen** · Datum: 2026-07-17

## Kontext

ADR-0001 §3 legt Last-Write-Wins über `updated_at` fest. Das ist eine
Client-Uhr: zwei Geräte mit abweichender oder verstellter Zeit können sich
gegenseitig überschreiben, ohne dass „zuletzt gewonnen" tatsächlich „zuletzt
angekommen" bedeutet. Zusätzlich war die Delete/Update-Reihenfolge nur
implizit über denselben Uhr-Vergleich geregelt und nirgends als eigene Regel
getestet — zwei gekoppelte Schwächen an derselben Code-Stelle (Issue #53).

Bei einem Nutzer mit 2-3 Geräten sind echte gleichzeitige Konflikte selten,
aber wenn sie auftreten, soll das Ergebnis deterministisch und nachvollziehbar
sein, nicht von der Systemzeit eines Telefons abhängen.

## Entscheidung

**Ankunft am Server entscheidet, nicht die Client-Uhr.** Eine einzige globale
Postgres-Sequence `sync_seq` vergibt bei jedem Schreiben (Insert **und**
Update) einen neuen, streng steigenden Wert. Die Zeile mit der höchsten
Sequenznummer gewinnt per Konstruktion — es gibt keine stille Ablehnung mehr
wegen „zu alter" Client-Zeit.

- **Eine globale Sequence, nicht pro Tabelle.** Der Client hält heute genau
  einen Pull-Cursor für alle Tabellen (`META_LAST_PULLED_AT`). Eine globale
  Sequence erhält das — ein Cursor bleibt ein Cursor.
- **Explizit gesetzt (`nextval('sync_seq')` im Statement), kein Spalten-
  Default.** Ein Default feuert nur bei Insert; ein Update braucht aber
  ebenso eine neue, höhere Sequenznummer.
- **Push-Transaktionen serialisieren über `pg_advisory_xact_lock`.** Ohne das
  könnte eine später gestartete, aber früher committende Transaktion eine
  noch uncommittete niedrigere Sequenznummer eines anderen Geräts
  „überspringen" — die Zeile würde für andere Geräte für immer unsichtbar.
  Bei einem Nutzer kostet die Serialisierung nichts.
- **`updated_at` bleibt Anzeige/Tiebreaker, ist aber nicht mehr Autorität.**
  Ein `baseSeq` im Mutation-Contract (die Sequenznummer der Zeilenversion, auf
  der die Bearbeitung fußt; `null` bei Neuanlage) erlaubt dem Server, unabhängig
  von der Uhr zu erkennen, ob eine Mutation eine noch nicht gesehene fremde
  Änderung überschreibt. Das wird als **Konflikt gemeldet** (ADR-0001: nie
  still verworfen), die Mutation wird trotzdem angewandt — Ankunft gewinnt.
- **Delete-Regel, jetzt explizit und getestet:**
  - `upsert` ist tombstone-neutral — es setzt oder löscht `deleted_at` nie.
    Ein Feld-Update kann eine gelöschte Zeile also nie „auferstehen" lassen,
    unabhängig von der Ankunftsreihenfolge gegenüber einem Delete.
    → **Delete gewinnt gegen Update, in beiden Reihenfolgen.**
  - `delete` setzt `deleted_at`.
  - `restore` (Undo eines Swipe-Delete) löscht `deleted_at`.
  - **`restore` vs. ein konkurrierendes `delete`: letzte Ankunft gewinnt**
    (höchste Sequenznummer). „Delete gewinnt" gilt bewusst nur gegen
    `upsert`, nicht gegen `restore` — sonst wäre Undo kaputt.
- **Wire-Contract-Wechsel:** Der Pull-Cursor wechselt von `now` (ISO-Zeit) auf
  `cursor` (Sequenznummer). Server und Client wandern dafür atomar im selben
  PR — kein Zwischenzustand mit gemischter Semantik.

## Konsequenzen

- Neue Pflicht-Spalte `sync_seq bigint NOT NULL` auf jeder synchronisierten
  Tabelle, zusätzlich zu den vier Spalten aus ADR-0001 §3 (macht fünf).
- Migration zweistufig: Spalte zunächst nullable + `CREATE SEQUENCE`, dann
  Custom-Migration mit Backfill (`ORDER BY updated_at`, um die bisherige
  Reihenfolge zu erhalten), erst danach `NOT NULL`. Ein direktes `NOT NULL`
  ohne Backfill schlägt auf jeder nicht-leeren Datenbank fehl.
- Ein wiederholt gesendeter, noch nicht bestätigter Mutation-Replay erhöht die
  Sequenz erneut und löst einen überflüssigen Re-Pull aus. Bewusst akzeptiert
  — `upsert` bleibt tombstone-neutral, es entsteht keine Zombie-Zeile.
- Kein Vendor-Lock-in: `CREATE SEQUENCE` und `pg_advisory_xact_lock` sind
  Standard-Postgres, keine Neon- oder Vercel-spezifischen Primitive.
- Rückweg (Down-Migration): Bestandsmigrationen sind forward-only (keine
  `.down.sql`-Dateien existieren). Der Rückbau ist daher hier dokumentiert und
  im PR-Text festgehalten, nicht als Migrationsdatei:

  ```sql
  ALTER TABLE sync_state DROP COLUMN sync_seq;
  ALTER TABLE tasks DROP COLUMN sync_seq;
  DROP SEQUENCE sync_seq;
  ```

  Vor dem Rückbau muss der Client wieder auf den `now`-Cursor zurückgesetzt
  werden (Wire-Contract), sonst sendet er einen numerischen `since`-Wert gegen
  einen Server, der ihn nicht mehr kennt.
- Folge-Ticket (nicht Teil dieses ADR): Konflikte sichtbar in der UI statt nur
  `console.warn` — ADR-0001 verlangt nur „nicht still", das ist mit Logging
  bereits erfüllt.
