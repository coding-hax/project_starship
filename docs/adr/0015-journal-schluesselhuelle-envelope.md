# ADR-0015: Journal-Schlüsselhülle — DEK/KEK-Envelope mit Recovery-Key

Status: **vorgeschlagen** · Datum: 2026-07-17
Ergänzt: den Abschnitt „Journal: Ende-zu-Ende-Verschlüsselung" in docs/ARCHITECTURE.md
(dort wird der Schlüssel heute direkt aus der Passphrase abgeleitet) und baut auf ADR-0004 auf.

## Kontext

Das Journal ist Ende-zu-Ende-verschlüsselt (M3). docs/ARCHITECTURE.md hält heute fest:
„Schlüssel wird aus einer Passphrase abgeleitet (Argon2id oder PBKDF2 via WebCrypto),
liegt nur auf dem Gerät." Der passphrase-abgeleitete Schlüssel **ist** damit direkt der
Datenschlüssel. Folge — als Limitation notiert: Passphrase vergessen → alle Einträge
unwiederbringlich weg. Ein einzelner Punkt für Totalverlust.

Issue #54 fragte nach einem Recovery-Kit, das diese Lücke schließt, **ohne** die
Zero-Knowledge-Eigenschaft zu schwächen (CLAUDE.md Regel 9: kein Klartext, kein Schlüssel
im Klartext zum Server). Die Recherche in #54 empfahl den ausdruckbaren Recovery-Key
(Ansatz A) auf Basis einer Envelope-Struktur; der Owner hat Ansatz A gewählt.

## Entscheidung

1. **Envelope-Verschlüsselung.** Ein zufälliger 256-bit **DEK** (Data Encryption Key)
   verschlüsselt alle Journal-Einträge (AES-GCM; gemäß ADR-0004 ein Chiffrat aus Text,
   Stimmung und Tags, nur `entry_date` bleibt Klartext). Der DEK wird **einmal** bei
   Journal-Aktivierung erzeugt.
2. **Der DEK liegt nie dauerhaft im Klartext vor.** Er wird von einem oder mehreren
   **KEKs** (Key Encryption Keys) **gewickelt** gespeichert:
   - **KEK-Passphrase** — aus der Passphrase via Argon2id abgeleitet. Primärer Entsperr-Pfad.
   - **KEK-Recovery** — aus einem hochentropischen Recovery-Key (256 bit, base32, gruppiert)
     abgeleitet. Zweiter, gleichwertiger Entsperr-Pfad.
3. **Gewickelte DEK-Blobs sind reines Chiffrat** (je KEK: Typ, wrapped ciphertext, nonce,
   KDF-Parameter) und dürfen serverseitig gespeichert und synchronisiert werden.
   Zero-Knowledge bleibt, und Multi-Device wird dadurch überhaupt erst möglich.
4. **Recovery-Key wird einmal angezeigt.** Bei Journal-Aktivierung, Muster und UX analog
   zum bestehenden Auth-Recovery-Code (src/app/anmelden/), danach für immer weg; Hinweis
   „in den Passwortmanager / ausdrucken".
5. **Getrennte Geheimnisse.** Der Journal-Recovery-Key ist **nicht** der Auth-Recovery-Code.
   Der Auth-Code wird serverseitig eingelöst (nur sein Hash liegt in der DB), der Journal-KEK
   muss clientseitig bleiben und darf den Server nie im Klartext erreichen. Eine Doppelrolle
   würde die Zero-Knowledge-Grenze mit der server-authentifizierten Grenze verquicken —
   bewusst vermieden. Wiederverwendet wird nur das **Muster/die UX**, nicht der Code.

## Verworfene Alternativen

- **Auth-Recovery-Code als Wrapping wiederverwenden (Ansatz B):** abgelehnt (Punkt 5).
- **Shamir Secret Sharing (Ansatz C):** zurückgestellt — überzogen für eine Single-User-App
  (neue Dependency, Verteil-/Rekonstruktions-UX, streift „genau eine Person"). Additiv später
  möglich, falls je nötig.
- **Bewusst nichts (Ansatz D):** als Endzustand abgelehnt — widerspricht dem Geist von
  Vision-Prinzip 4 („kein Format, aus dem ich nicht wieder herauskomme"). Die klare
  Risiko-Ansage bleibt aber Teil des Aktivierungs-Screens, denn auch der Recovery-Key kann
  verloren gehen.

## Konsequenzen

- **Fundament zuerst.** Die DEK/KEK-Trennung muss **vor** den ersten echten Journal-Einträgen
  stehen. Nachträglich einzuziehen bedeutet eine Re-Verschlüsselungs-Migration über alle
  Journal-Daten. Diese Entscheidung gehört daher an den Anfang von M3.
- **Datenmodell (späteres Umsetzungs-Ticket):** ein Ort für die gewickelten DEK-Blobs, z. B.
  eine Tabelle `journal_keys` (kek_type `'passphrase'|'recovery'`, wrapped_dek, nonce,
  kdf_params + die vier Sync-Pflichtspalten). Alles Chiffrat. Drizzle-Migration mit Up-/Down-Pfad
  (CLAUDE.md Regel 4). Geschützter Pfad `src/db/` → `human-approved` nötig.
- **Neue Dependency (späteres Umsetzungs-Ticket, eigener ADR-Punkt):** Argon2id ist in WebCrypto
  nicht nativ; eine WASM-Lib ist wahrscheinlich nötig (CLAUDE.md Regel 3). Diese ADR entscheidet
  Argon2id **nicht** abschließend — sie benennt nur den Bedarf. Alternative bleibt PBKDF2 via
  WebCrypto ohne neue Dependency (schwächere Parameter). Entscheidung im Umsetzungs-Ticket.
- **Geschützte Pfade:** `src/crypto/` und `src/db/` — jeder spätere Umsetzungs-PR braucht
  `human-approved`.
- **UX (späteres Ticket):** Aktivierungs-Screen zeigt den Recovery-Key einmal, mit klarer
  Risiko-Ansage; ein druckbares „Emergency-Kit" ist eine optionale spätere UX-Schicht.
- **Sequenzierung:** Umsetzung ist eine eigene M3-Ticket-Kette — (1) Envelope + Passphrase-KEK
  + `journal_entries` + `journal_keys`, (2) Recovery-Key als zweiter KEK samt Einmal-Anzeige —
  und beginnt erst, wenn M3 in der strikt sequenziellen Roadmap an der Reihe ist.
- **Diese ADR ändert keinen Code und keine Architektur-Doku.** Sie ist eine vorgeschlagene
  Entscheidung. Bei Annahme wird der ARCHITECTURE.md-Abschnitt „Journal: Ende-zu-Ende-
  Verschlüsselung" auf das Envelope-Modell umgeschrieben (eigener kleiner Folgeschritt).
