# Code-Karte: Journal (`src/features/journal`)

- `write.ts` / `entry.ts` — Schreibpfad plus Listen, Anhängen, Löschen
- `journal-keys.ts` — liest/schreibt Envelope und Recovery-Envelope
- `journal-key-stash.ts` — fängt einen beim Pull verdrängten Envelope auf
- `recover-orphaned-entries.ts` — bergt Einträge unter altem DEK, neu verschlüsselt
- `dek-session.ts` / `use-journal-persist-pref.ts` — opt-in persistierter DEK + Pref
- `lock-store.ts` — Entsperr-Automat: setup/locked/unlocked, Auto-Lock nach 15 Min
- `decrypt-journal-row.ts` — entschlüsselt Zeilen einzeln, unlesbare fällt raus
- `use-journal-entries.ts` / `use-journal-search-entries.ts` / `use-orphaned-key.ts` — Live-Query-Hooks
- `journal-editor.tsx` / `.css` — Tagzeile, Editor für den aktuellen Eintrag
- `same-day.ts` / `journal-current-day.ts` / `journal-day-nav.tsx` — Tageswechsel, „An diesem Tag"
- `search.ts` / `journal-search-*.ts(x)` / `.css` — Suche: Cache, Modul-Store, Chips, Filter
- `journal-page-head.tsx` / `journal-view-mode.ts` — PageHead: Tagnav- oder Suchmodus
- `journal-gate.tsx` / `.css` — Zustands-UI: setup/locked/unlocked, Recovery-Screen
- `journal-settings-panel.tsx` / `.css` — Opt-in-Toggle + Recovery-Key neu ausstellen
- `journal-habit.ts` — feste Journal-Routine: anlegen, archivieren, abhaken
- `journal-habit-boot.tsx` — legt die Journal-Routine nach dem ersten Pull an
