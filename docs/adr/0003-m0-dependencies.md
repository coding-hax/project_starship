# ADR-0003: Dependencies für M0

Status: **angenommen** · Datum: 2026-07-14

> Die Nummer 0002 bleibt frei: `VISION.md` und `ARCHITECTURE.md` verweisen bereits auf
> ein ADR-0002 zum Thema Kalender (einseitiger `.ics`-Feed), das noch nicht geschrieben ist.

## Kontext

`ARCHITECTURE.md` legt den Stack fest (Next.js, Dexie, Serwist, Drizzle, Postgres,
Vitest, Playwright, Tailwind). Drei Bausteine, die M0 braucht, sind dort **nicht** benannt.
CLAUDE.md Regel 3 verlangt dafür ein ADR.

## Entscheidungen

### 1. `@simplewebauthn/server` + `@simplewebauthn/browser` (Passkey)

**Entscheidung:** angenommen.

**Begründung:** Die Registrierungs-Verifikation verlangt CBOR-Decoding, COSE-Key-Parsing
und Attestation-Prüfung. Das von Hand zu bauen heißt, sicherheitskritischen Code ohne
Review in einen geschützten Pfad zu legen. SimpleWebAuthn ist der De-facto-Standard,
implementiert die Spec vollständig und hat keinen Vendor-Bezug.

**Alternative:** Eigenimplementierung über WebCrypto. Verworfen — der Aufwand ist real,
das Risiko still: ein Fehler dort ist ein Auth-Bypass, kein Bug.

### 2. `pg` (node-postgres) als Treiber

**Entscheidung:** angenommen.

**Begründung:** ADR-0001 verbietet anbieterspezifische Primitive. `pg` spricht über einen
normalen Connection-String mit lokaler Postgres im Docker, mit Neon und mit jedem eigenen
Server — der Umzug bleibt eine Konfigurationsentscheidung, wie gefordert.
Der Neon-Serverless-Treiber ist ausdrücklich **ausgeschlossen**.

**Alternative:** `postgres.js` — funktional gleichwertig, etwas schlanker, weniger verbreitet.

### 3. `uuidv7`

**Entscheidung:** angenommen.

**Begründung:** IDs werden clientseitig erzeugt (Offline-Anlage ohne Roundtrip) und müssen
zeitlich sortierbar sein. Der heikle Teil der Spec ist die Monotonie **innerhalb derselben
Millisekunde** — wer das von Hand baut, merkt den Fehler erst, wenn der Sync Datensätze
in falscher Reihenfolge anwendet. Das Paket ist ~2 kB und hat keine transitiven Abhängigkeiten.

### 4. Kein JWT, keine Session-Bibliothek

**Entscheidung:** Session-Token ist ein opakes Zufallstoken (32 Byte, CSPRNG), gespeichert
als Hash in Postgres. Kein `jose`, kein `next-auth`.

**Begründung:** Bei einem einzigen Nutzer bringt ein signiertes, selbstbeschreibendes Token
keinen Vorteil — es gibt nichts zu skalieren und niemanden, an den man es weiterreicht.
Ein opakes Token ist serverseitig widerrufbar; ein JWT ist es nicht. Weniger Code,
weniger Abhängigkeit, mehr Kontrolle.

## Konsequenzen

- Neue Laufzeit-Abhängigkeiten: `@simplewebauthn/server`, `@simplewebauthn/browser`,
  `pg`, `drizzle-orm`, `dexie`, `uuidv7`, `serwist`/`@serwist/next`.
- Alle sind vendor-neutral. Die Portabilitätsregel aus ADR-0001 bleibt gewahrt.
- Sessions liegen in der DB (`sessions`-Tabelle) und sind damit widerrufbar.
