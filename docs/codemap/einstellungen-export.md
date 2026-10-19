# Code-Karte: Einstellungen, Export

## src/features/export

- `export.ts` / `export-panel.tsx` / `.css` — baut die Export-Payload, löst Download aus

## src/features/settings

- `use-appearance.ts` / `appearance-panel.tsx` — Theme, Reduce-Motion, Textgröße
- `use-capture-prefs.ts` / `capture-panel.tsx` — Toggle „ohne Bestätigung direkt anlegen"
- `use-modules.ts` / `module-panel.tsx` — Modul-Ein/Aus, Kernmodul nie abschaltbar
- `use-weather-location.ts` / `weather-panel.tsx` / `.css` — Wetter-Ort suchen/auswählen
- `ics-subscriptions-panel.tsx` / `.css` — .ics-Abos hinzufügen/entfernen, Fehler je Abo
- `use-nav-order.ts` / `nav-order-panel.tsx` / `.css` — Reihenfolge der Nav-Einträge
- `use-push.ts` / `use-reminder-prefs.ts` / `push-panel.tsx` / `.css` — Push-Hook, Prefs, Panel an/aus
- `use-devices.ts` / `devices-panel.tsx` / `.css` — „Passkeys": Umbenennen, Widerruf
- `use-sessions.ts` / `session-panel.tsx` / `logins-panel.tsx` / `.css` — sperren, Liste + zuletzt gesehen
- `use-category-colors.ts` / `category-colors-panel.tsx` / `.css` — Zehnerpalette je Kategorie
- `category-colors-boot.tsx` — setzt/entfernt die Kategorie-Farbvariable am Root
- `calendar-settings-panel.tsx` — Kalenders Settings-Slot: Farben + ICS-Abos
- `use-habit-history-range.ts` / `routines-settings-panel.tsx` / `.css` — Zeitraum der Verlaufskarte (30 Tage … 1 Woche)
- `use-admin-role.ts` / `verwaltung-panel.tsx` / `.css` — Link auf /admin, role=admin (sonst nicht im DOM)

## src/features/admin

- `accounts-overview.ts` / `use-admin-overview.ts` / `admin-overview.tsx` / `.css` — Kennzahlen je Konto, nie Nutzerinhalt
