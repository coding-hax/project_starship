# START HIER

> Diese Datei ist der Startauftrag für die **erste Claude-Session** in diesem Repo.
> Lies sie vollständig, bevor du irgendetwas tust. Wenn der Bootstrap abgeschlossen
> ist, wird diese Datei gelöscht — ab dann gilt `CLAUDE.md`.

---

## Was hier gebaut wird

Eine persönliche Produktivitäts-Web-App (PWA) für **genau eine Person**:
Termine, Aufgaben, Journal, Gewohnheiten. Mobile-first, offline-fähig, soll sich
schnell und leicht anfühlen und lebensfrohe Farben haben.

Alles Weitere steht in den Dokumenten. **Lies sie jetzt, in dieser Reihenfolge:**

1. `docs/VISION.md` — was wir bauen, was ausdrücklich **nicht**, und die Roadmap
2. `docs/ARCHITECTURE.md` — Stack, Datenmodell, Local-first-Sync
3. `docs/adr/0001-initiale-entscheidungen.md` — bereits getroffene Entscheidungen.
   **Diese werden nicht neu verhandelt.**
4. `docs/DESIGN_SYSTEM.md` — Farben, Typografie, Motion, Mobile-Patterns
5. `docs/WORKFLOW.md` — wie ein Ticket zum Merge wird
6. `docs/TOKEN-BUDGET.md` — welches Modell wofür, und wie wir Kontext sparen
7. `CLAUDE.md` — die harten Regeln für die tägliche Arbeit

---

## Der Zustand

Das Repo ist **leer**. Es gibt nur die Dokumente oben, `scripts/` und `.claude/`.
Kein Code, kein `package.json`, kein GitHub-Setup.

## Dein Auftrag: der Bootstrap (Milestone M0)

Arbeite die folgenden Schritte **der Reihe nach** ab. Nach jedem Schritt: committen.
Baue **kein einziges Feature** — weder Aufgaben noch Termine noch sonst etwas.
M0 ist fertig, wenn ein leeres, installierbares App-Gerüst steht, das grün durch die CI geht.

### 1. Fundament

- `git init`, sinnvolle `.gitignore`
- pnpm, Next.js (App Router) + TypeScript + Tailwind
- ESLint + Prettier, dazu die Skripte `dev`, `lint`, `typecheck`, `test`, `e2e`
- Ordnerstruktur exakt wie in `docs/CODEMAP.md` beschrieben

### 2. Datenbank

- Drizzle einrichten, Postgres lokal via Docker Compose für die Entwicklung
- `src/db/schema.ts` mit den **Pflichtspalten** aus `ARCHITECTURE.md`
  (`id` UUIDv7, `updated_at`, `deleted_at`, `synced_at`) — aber **noch ohne Feature-Tabellen**.
  Lege nur `sync_state` an, damit die Migrationskette steht.
- Skripte `db:generate`, `db:migrate`

### 3. Local-first-Grundgerüst

- `src/local/dexie.ts`, `src/local/outbox.ts`, `src/local/sync.ts`
- Nur das **Gerüst**: Outbox-Queue, Push/Pull-Endpunkte unter `src/app/api/sync/`,
  Last-Write-Wins. Noch keine Entität, die damit synchronisiert wird.
- Das ist der wichtigste Teil von M0. Lieber hier gründlich sein als schnell.

### 4. Auth

- Passkey/WebAuthn, Single-User gegen `OWNER_USER_ID` aus der Env
- Recovery-Code beim ersten Start, einmalig angezeigt
- Session-Cookie: httpOnly, Secure, SameSite=Lax, lange Laufzeit

### 5. PWA

- Serwist: Service Worker + Manifest + Icons
- Muss sich auf dem iPhone über Safari → „Zum Home-Bildschirm" installieren lassen
  und dort im Standalone-Modus starten. **Das ist ein Akzeptanzkriterium, kein Extra.**

### 6. Design-System

- Farbtokens (OKLCH, hell + dunkel) aus `docs/DESIGN_SYSTEM.md` in `src/ui/tokens.css`
- App-Shell: Bottom-Navigation (Mobile) / Sidebar (Desktop), vier leere Tabs,
  Safe-Area-Insets, `prefers-reduced-motion` respektiert

### 7. Tests & CI

- Vitest (Logik) und Playwright (E2E) einrichten
- Playwright: `trace: 'retain-on-failure'`, Screenshots und Video nur bei Fehlschlag
- Ein erster E2E-Test: App startet, Login per Passkey (gemockt), vier Tabs sind erreichbar
- GitHub Actions: `lint` → `typecheck` → `test` → `e2e`, läuft bei jedem PR

### 8. GitHub-Setup

- Labels anlegen: `ready`, `in-progress`, `needs-input`, `blocked-limit`,
  `human-approved`, `model:haiku`
- Milestones anlegen: M0 bis M6 (Titel aus `docs/VISION.md`)
- Issue-Template aus `docs/WORKFLOW.md` unter `.github/ISSUE_TEMPLATE/feature.md`
- Ein **angepinntes Issue** mit dem Titel `🚦 Runner-Status` anlegen und seine Nummer
  in `scripts/claude-runner.sh` (Variable `STATUS_ISSUE`) eintragen
- **Branch-Schutz auf `main`** exakt wie in `docs/WORKFLOW.md` beschrieben:
  Required Checks `quality`, `e2e`, `test-integrity`, `protected-paths`,
  Auto-Merge und Squash-Merge aktiviert, kein direkter Push.
  **Ohne diesen Schritt ist der Auto-Merge wertlos** — dann könnte Claude
  rote PRs mergen. Er ist die einzige echte Schranke im ganzen System.
- `scripts/check-test-integrity.sh` ausführbar machen und einmal gegen einen
  absichtlich kaputten Test testen: der Check MUSS rot werden.

### 9. Runner scharf schalten

- `scripts/claude-runner.sh` ausführbar machen, Pfade prüfen
- `scripts/systemd-setup.md` abarbeiten (Timer alle 20 Minuten)
- **Aber noch nicht starten** — erst wenn der Mensch das freigibt.

### 10. Aufräumen

- `docs/CODEMAP.md` an die tatsächlich entstandene Struktur anpassen
- **Diese Datei (`START-HERE.md`) löschen**
- Kurzen Bericht schreiben: was steht, was fehlt, was du anders gemacht hast als geplant

---

## Regeln während des Bootstraps

**Der Mensch sitzt beim Bootstrap am Rechner.** Du darfst hier also direkt im
Terminal fragen. Das gilt **nur** für diesen Bootstrap — sobald der Runner läuft,
gehen alle Fragen ausschließlich als Kommentar am GitHub-Issue raus (siehe `CLAUDE.md`).

- **Frag, statt zu raten.** Besonders bei allem, was das Datenmodell oder den
  Sync betrifft — das später zu ändern ist teuer.
- **Keine Dependency, die nicht in `ARCHITECTURE.md` steht**, ohne dass du fragst.
- **Keine Features.** Wenn du versucht bist, „schnell mal" eine Aufgabenliste
  einzubauen: nein. Das ist M1 und bekommt ein eigenes Ticket.
- **Committe nach jedem Schritt.** Nicht ein großer Commit am Ende.
- **Halte dich an die Token-Regeln** aus `docs/TOKEN-BUDGET.md`. Auch hier gilt:
  Suchen an den Explore-Subagenten, Tests an den test-runner-Subagenten.

## Fertig ist M0, wenn

- [ ] Die App lässt sich auf dem iPhone installieren und startet im Standalone-Modus
- [ ] Login per Face ID funktioniert
- [ ] Vier leere Tabs, korrekt in hell und dunkel, auf 375px und 1280px
- [ ] Die Outbox nimmt eine Test-Mutation entgegen, überlebt einen Reload und
      landet nach dem Wiederverbinden in Postgres
- [ ] `pnpm lint`, `typecheck`, `test`, `e2e` sind grün — lokal **und** in der CI
- [ ] Labels, Milestones, Issue-Template und Status-Issue existieren
- [ ] Branch-Schutz steht; ein PR mit rotem Test lässt sich nachweislich NICHT mergen
- [ ] Ein PR, der `src/db/` anfasst, wird nachweislich von `protected-paths` blockiert
- [ ] `START-HERE.md` ist gelöscht

---

## Offene Fragen — stelle sie, bevor M1 beginnt

Diese Punkte sind in `docs/VISION.md` als Annahme gesetzt. Frag sie ab, sobald M0 steht,
und trage die Antworten in die Vision ein:

1. **Gewohnheiten:** binär (erledigt / nicht erledigt) mit Streak — oder auch
   Mengenziele wie „30 Minuten lesen"? Das ändert das Datenmodell.
2. **Journal-Tags:** bleiben Datum, Stimmung und Tags im Klartext (dann sind
   serverseitige Filter möglich), oder werden sie mitverschlüsselt?
3. **Wiederkehrende Aufgaben:** ab M1 in einfacher Form, oder erstmal weglassen?
4. **Erinnerungen:** Web Push ab M5 — oder braucht es sie früher?

Danach schreibst du die M1-Tickets, legst sie mit Label `ready` an, und der Runner
übernimmt.
