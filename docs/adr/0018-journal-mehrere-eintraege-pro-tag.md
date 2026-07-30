# ADR-0018: Journal — mehrere Einträge pro Tag statt Autosave

Status: **angenommen** · Datum: 2026-07-29
Löst ab: **ADR-0017 Punkt 1** (deterministische UUIDv5-id aus `entry_date`). ADR-0017
Punkt 2 (atomares Chiffrat) und Punkt 3 (Konflikt-Kopie) bleiben unverändert gültig.
Ergänzt ADR-0004 (Verschlüsselungsschnitt) — dort ändert sich nichts.

## Kontext

Am 29.07.26 im echten Gebrauch entschieden (issue #376): das Journal hatte einen
autogespeicherten Eintrag pro Tag (S3b, issue #340). Ohne Absenden-Knopf und ohne
Rückmeldung war beim Schreiben nicht erkennbar, ob überhaupt etwas gespeichert wurde —
das Grundversprechen der App ("ein Ort für den Tag", Produktprinzip 1) trug hier nicht.

ADR-0017 hatte "ein Eintrag je Tag" bewusst zu einer echten Schlüssel-Invariante
gemacht (deterministische id aus `entry_date`), um den ADR-0008-Konfliktpfad ohne
Sonderfall nutzen zu können. Diese Prämisse fällt mit der Owner-Entscheidung, dass ein
Tag mehrere Einträge tragen soll.

## Entscheidung

1. **Kein Autosave mehr.** Der Editor hat ein Textfeld und einen Absenden-Knopf;
   gespeichert wird nur bei explizitem Absenden.
2. **Ein Tag kann beliebig viele Einträge tragen.** Die Zeilen-id ist ab sofort
   client-zufällig (UUIDv7, wie bei jeder anderen Tabelle) statt deterministisch aus
   `entry_date` — ADR-0017 Punkt 1 ist damit abgelöst. `entry_date` bleibt als
   Klartextfeld bestehen (ADR-0004), verliert aber seine Eindeutigkeit.
3. **`created_at` ist der Sortier-/Anzeigeanker** je Eintrag (neueste zuerst, mit
   Uhrzeit) — client-gesetzt beim Schreiben, gleiches Muster wie `tasks`/`habits`
   (`syncSeq` ändert sich bei jedem Sync und taugt nicht als Erstellzeit).
4. **Stimmung und Tags gehören zum einzelnen Eintrag**, nicht mehr zum Tag — sie waren
   ohnehin schon Teil des einen Chiffrats je Zeile (ADR-0004/-0017 Punkt 2), das
   ändert sich nicht, nur die Zeilen-Kardinalität pro Tag.
5. **Löschen ist Soft-Delete über den bestehenden Sync-Pfad** — kein neuer Lösch-Weg.

## Begründung

Die deterministische id existierte ausschließlich, um "ein Eintrag je Tag" zu
erzwingen. Fällt diese Anforderung, fällt auch der Grund für die deterministische id —
eine zufällige UUIDv7 ist der Normalfall in diesem Schema (siehe `tasks`, `habits`,
`habit_logs`) und braucht keine Sonderbehandlung im Sync-Motor. Der Konfliktpfad aus
ADR-0017 Punkt 3 (`journalConflicts`, verdrängte Chiffrat-Fassung) wird durch den
Wegfall der Kollisionsmöglichkeit zwar praktisch ungenutzt — zwei Geräte, die
offline für denselben Tag schreiben, legen jetzt zwei Zeilen an statt eine zu
überschreiben — er bleibt aber im Code, weil sein Entfernen ein eigenes Risiko ist,
das nicht in diesem Ticket mitentschieden werden soll (eigenes Aufräum-Ticket, siehe
issue #376).

**Nachtrag issue #395:** Das Aufräum-Ticket hat entschieden (Owner-Variante A): nur
der nachweislich tote Producer in `src/local/sync.ts` wird entfernt. Restore-UI und
der `journalConflicts`-Store bleiben stehen, falls auf einem Gerät noch eine
unrestaurierte Alt-Kopie aus der Zeit vor #376 liegt.

## Konsequenzen

- **Migration:** `journal_entries` bekommt `created_at` (`timestamp with time zone
  default now() not null`, Backfill wie bei `tasks`/`habits`); der Unique-Index auf
  `entry_date` wird durch einen normalen Index ersetzt. Bestandszeilen bleiben gültige
  Einträge, keine Umschlüsselung nötig.
- `src/local/uuid5.ts` (`journalEntryId`) hat keinen Aufrufer mehr und ist entfernt.
- „Heute schon geschrieben?" (issue #342) liest jetzt "mindestens ein Eintrag heute"
  statt "die eine Zeile existiert" — bei mehreren Einträgen zeigt die Übersicht die
  Stimmung des zuletzt geschriebenen.
- Die Suche (issue #341) findet einzelne Einträge, nicht Tage; ein Treffer zeigt Datum
  **und** Uhrzeit.
- **Restrisiko unverändert wie ADR-0017:** bearbeitet man denselben Tag gleichzeitig
  auf zwei Geräten, entstehen jetzt schlicht zwei Einträge statt eines Konflikts — das
  ist mit "mehrere Einträge pro Tag" kein Fehlerfall mehr, sondern das erwartete
  Verhalten (AC8).

## Verworfene Alternativen

- **Autosave beibehalten, nur eine Rückmeldung ergänzen (Toast "Gespeichert"):** löst
  das eigentliche Problem nicht — der Nutzer merkt beim Schreiben selbst weiterhin
  nicht, *wann* gespeichert wird, nur nachträglich. Der Owner hat sich für einen
  expliziten Absenden-Knopf entschieden (issue #376).
- **Deterministische id beibehalten, mehrere Einträge über ein Array im selben
  Chiffrat:** verletzt ADR-0017 Punkt 2 (atomares Chiffrat, kein feldweiser Merge) auf
  andere Weise — bei zwei Geräten, die offline je einen neuen Eintrag anhängen, würde
  eines der beiden Arrays beim Sync verlustfrei nur durch erneute Konflikt-Logik
  überleben. Eine Zeile je Eintrag nutzt den vorhandenen, bewährten ADR-0008-Pfad
  direkt.
