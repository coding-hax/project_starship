# Code-Karte: Design-System-Bausteine (`src/ui`, keine Feature-Logik)

- `page-head.tsx` / `.css` — Dreizonen-Kopf: Augenbraue, Titel, Zusatz
- `mood-scale.tsx` / `.css` — zehn Ein-Tipp-Punkte, Skala 1–10
- `background-arcs.tsx` / `.css` — drei Bögen hinterm Grund, gleich je Route
- `faces.tsx` / `.css` — eine Figur je Route, Inline-SVG mit CSS-Blinzeln
- `swatch-palette.ts` — zehn Farbnamen, Quelle für Habit-Editor und Kategorie-Panel
- `tokens.css` / `motion.css` / `shell.css` — Farbtokens, Spring-Presets, App-Shell
- `use-list-presence.ts` — hält entfernte Zeilen bis zum Ende der Exit-Animation
- `use-now.ts` — tickendes Datum, treibt z. B. die Kalender-Jetzt-Linie
- `use-online.ts` / `offline-notice.tsx` / `.css` — Online-Status + geteilte Offline-Notiz
- `app-header.tsx` / `nav-items.ts` / `nav.tsx` / `module-route-guard.tsx` — Nav-Ableitung, Aus-Route-Redirect
- `sheet.tsx` / `.css` / `fab.tsx` / `.css` — Bottom-Sheet, Floating Action Button
- `toast-host.tsx` / `toast.tsx` / `.css` — zentraler Toast-Host plus Toast
- `row/section-card/toggle/segmented-control/slider.tsx` / `.css` — Form-Primitive
- `overview-block.tsx` / `.css` — /uebersicht: Rahmen plus Kopf mit Titel und Link
- `field-hint.tsx` / `.css` — Warnfarbene Notiz für ein geratenes Feld
- `sync-boot.tsx` / `persist-storage.ts` / `sync-status.tsx` / `stale.ts` — Sync-Start, Fehler-Toast, Stale-Helfer
- `e2e-bridge.tsx` — Test-Zugriff auf Outbox/Journal/Dexie-Dump, nur im E2E-Build
