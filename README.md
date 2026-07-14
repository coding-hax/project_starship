# Starship

Eine persönliche Produktivitäts-PWA für **genau eine Person**: Termine, Aufgaben,
Journal, Gewohnheiten. Mobile-first, offline-fähig, local-first.

Verbindliche Arbeitsanweisung: [CLAUDE.md](CLAUDE.md).
Warum etwas so ist, wie es ist: [docs/](docs/) und [docs/adr/](docs/adr/).

## Loslegen

```bash
pnpm install
cp .env.example .env.local          # OWNER_USER_ID setzen!
docker compose up -d                # lokale Postgres
pnpm db:migrate
pnpm dev                            # http://localhost:3000
```

Beim ersten Aufruf legst du unter `/anmelden` deinen Passkey an. Der
**Wiederherstellungscode wird genau einmal angezeigt** — ohne ihn kommst du nach dem
Verlust des Passkeys nicht mehr rein.

## Befehle

```bash
pnpm dev           # Entwicklung
pnpm lint          # ESLint
pnpm typecheck     # tsc --noEmit
pnpm test          # Vitest (Logik)
pnpm e2e           # Playwright (braucht die laufende Postgres)
pnpm db:generate   # Drizzle-Migration erzeugen
pnpm db:migrate    # Migration anwenden
```

## Zwei Dinge, die man wissen muss

**Der Build läuft mit Webpack, nicht mit Turbopack.** Serwist (der Service Worker)
ist ein Webpack-Plugin, und die Kombination mit Turbopack bricht den Build. Nimmt man
das `--webpack`-Flag weg, verschwindet der Service Worker und mit ihm die
Installierbarkeit — ohne dass irgendein Test rot wird.

**Die UI spricht nie direkt mit der API.** Jede Schreiboperation geht durch
`src/local/outbox.ts` nach IndexedDB und von dort in den Sync. Wer das umgeht, hat
local-first kaputtgemacht.

## Live

**https://starship-alpha.vercel.app** — Vercel (Production), Postgres auf Neon
(`eu-central-1`, Frankfurt). Pushes auf `main` deployen automatisch; `main` ist
branch-geschützt, es geht also nur live, was durch alle vier CI-Checks kommt.

Passkeys sind **an die Domain gebunden**. Ein lokal auf `localhost` angelegter Passkey
funktioniert online nicht und umgekehrt — das ist die Sicherheitsgarantie von WebAuthn,
kein Fehler. Lokale Entwicklung und Produktion sind zwei getrennte Welten mit zwei
getrennten Datenbanken.

## Stand

M0 (Fundament) steht und ist verifiziert: PWA auf dem iPhone im Standalone-Modus
installiert, Login per Face ID, Sync-Grundgerüst mit Outbox (Mutation überlebt Reload
und landet in Postgres), Design-Tokens, App-Shell, CI mit vier Required Checks.

Noch **kein** Feature — Aufgaben sind M1.
