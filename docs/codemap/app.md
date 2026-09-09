# Code-Karte: Routen & API (`src/app`)

- `middleware.ts` — Auth-Gate vor (app): nur Cookie-Check, sonst → /anmelden
- `(app)/layout.tsx` — App-Shell, Modul-Route-Guard
- `(app)/page-transition.tsx` — Opacity-Crossfade um Seiteninhalt
- `(app)/uebersicht/page.tsx` — Dashboard: Ring, Einstellungs-Einstieg, Erfassungs-FAB, Modul-Sektionen
- `(app)/aufgaben/page.tsx` — Kopfzeile, Aufgabenliste, Schnellerfassung
- `(app)/kalender/page.tsx` — Tages-Timeline, Termin-Editor, Monats-/Serienansicht
- `(app)/routinen/page.tsx` / `(app)/aktivitaeten/page.tsx` — Routinen-Verwaltung, Garmin-Aktivitäten
- `(app)/wetter/[datum]/page.tsx` — Stundenverlauf, Niederschlag, Wind, Sonnenzeiten
- `(app)/journal/page.tsx` — Titelzeile mit Datum, rendert Journal-Zustand
- `(app)/einstellungen/page.tsx` — Darstellung, Reihenfolge, Module, Push je Panel
- `anmelden/` / `offline/page.tsx` — Passkey: Einrichten/Anmelden/Recovery; SW-Fallback ohne Netz
- `api/auth/` — WebAuthn (register/login/logout/status), Geräte-/Sitzungswiderruf
- `api/health/route.ts` / `api/garmin-sync/route.ts` — SELECT 1+Versions-SHA (offen); holt Aktivitäten (Bearer-Secret)
- `api/sync/` / `api/sync/pull/read-changes-since.ts` — push/pull (einziger Datenzugriff); seitenweiser Snapshot-Lesekern, Cursor-Konsistenz
- `api/push/` — Abo (subscribe/unsubscribe/test) + Reminder-Versand, Bearer-Secret
- `api/ics/` / `ssrf.ts` / `route.ts` — SSRF-Proxy für .ics-Feeds, Owner-geschützt
- `layout.tsx` / `manifest.ts` / `globals.css` / `sw.ts` — Root-Layout, PWA-Manifest, Tokens; Service Worker (Push/Notification)
