# ADR-0017: Sync über verschlüsselte Journal-Einträge — deterministische id + Konflikt-Kopie

Status: **vorgeschlagen** · Datum: 2026-07-28
Ergänzt ADR-0008 für Tabellen, deren Nutzinhalt ein opakes Chiffrat ist (Journal, ADR-0004). ADR-0008 selbst bleibt unverändert „angenommen".

## Kontext

ADR-0008 löst Konflikte über eine server-monotone sync_seq + baseSeq; der partielle Feld-Merge erlaubt zwei Geräten, verschiedene Felder derselben Zeile zu bearbeiten, ohne sich zu überschreiben. journal_entries trägt aber Text, Stimmung und Tags in *einem* Chiffrat (ADR-0004) — der Feld-Merge ist damit wirkungslos: das Chiffrat ist genau ein Feld, bei konkurrierender Bearbeitung gewinnt zwangsläufig der ganze Blob der letzten Ankunft. Zweitens ist „ein Eintrag je Tag" heute nur eine App-Invariante: der Konflikt-Mechanismus (src/local/conflict.ts) schlüsselt auf die Zeilen-id (UUIDv7), nicht auf entry_date — zwei Geräte könnten offline für denselben Tag zwei verschiedene Zeilen anlegen.

Der Owner hat in #301 die Variante C gewählt (Antwort „2c").

## Entscheidung (C)

1. **Deterministische id aus entry_date** für journal_entries (UUIDv5 mit festem Namespace über die entry_date-Zeichenkette). Derselbe Tag ⇒ dieselbe Zeilen-id auf allen Geräten ⇒ „ein Eintrag je Tag" wird eine echte Schlüssel-Invariante, und ADR-0008 greift normal: baseSeq erkennt und meldet den Konflikt (nie still).
2. **Das Chiffrat ist atomar.** Kein feldweiser Merge über ciphertext/nonce — eine upsert-Mutation ersetzt beide gemeinsam. entry_date ist der Schlüssel und wird nicht „bearbeitet".
3. **Konflikt-Kopie.** Erkennt der Push einen Overwrite (detectOverwrite, ADR-0008), behält der Client die verdrängte Chiffrat-Fassung lokal und bietet sie in der Journal-UI an. Der Konflikt ist damit erkannt *und* verlustfrei.
   **Stillgelegt mit issue #395:** der Pull-seitige Producer in `src/local/sync.ts`, der diese Kopie in `journalConflicts` ablegte, ist entfernt — seit ADR-0018 ist die Zeilen-id zufällig, der Zweig konnte nicht mehr feuern (siehe ADR-0018 Begründung). Restore-UI und der `journalConflicts`-Store bleiben als Abfluss für eine evtl. noch nicht wiederhergestellte Alt-Kopie stehen.

## Begründung

Bei einem Autor / 2–3 Geräten sind echte Gleichzeitig-Konflikte am selben Tag selten. Die deterministische id nutzt den vorhandenen ADR-0008-Pfad, statt eine zweite Zeile zu erzeugen, die der Client nach Entschlüsselung erst versöhnen müsste. Die Konflikt-Kopie schließt den einzigen echten Verlustpfad (Ganz-Blob-Überschreibung).

## Konsequenzen

- journal_entries: die id ist client-deterministisch statt zufällig; erzeugt in der Journal-Schreiblogik, nicht im Sync-Motor. Der Motor bleibt inhaltsblind — journal_entries ist nur ein weiterer SYNC_REGISTRY-Eintrag (writable/required: entryDate, ciphertext, nonce).
- Server-Code (push/pull, conflict.ts) bleibt unberührt — die ADR-0008-Regeln greifen wie gehabt, sobald die id deterministisch ist.
- Die Konflikt-Kopie braucht einen lokalen Ablageort (Dexie) + eine kleine UI — Detail des M4-Umsetzungs-Tickets, nicht dieser ADR.
- Restrisiko bewusst: bearbeitet man denselben Tag gleichzeitig auf zwei Geräten, überschreibt die spätere Ankunft die frühere Textfassung — sichtbar gemacht via Konflikt-Kopie, nicht still (ADR-0001).

## Verworfene Alternativen
- **A (zufällige id + Client-Versöhnung zweier Zeilen):** mehr Client-Komplexität (Merge-Regel nach Entschlüsselung) ohne Vorteil bei diesem Nutzungs-/Bedrohungsmodell.
- **B (deterministische id ohne Konflikt-Kopie):** ließe die verdrängte Fassung verloren gehen.
