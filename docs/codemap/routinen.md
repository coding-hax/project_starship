# Code-Karte: Routinen (`src/features/habits`)

- `use-habits.ts` / `use-habit-logs.ts` / `use-toggle-habit-log.ts` — Live-Queries + Abhaken/Zurücknehmen
- `due-today.ts` / `schedule-rules.ts` / `habit-progress.ts` — Fälligkeits- und Erledigt-Regeln, teilen Ring und Kopf-Link
- `streak.ts` — Streak-Berechnung inklusive ruhender Freezes
- `week-goal.ts` / `history-weeks.ts` / `history-days.ts` / `month-progress.ts` — reine Ableitungen: Wochensoll, 12-Wochen-, 30-Tage-, Monatsreihe
- `habit-today.tsx` / `.css` — Abhak-Liste, Streak-Badge auf der Übersicht
- `habits-overview-section.tsx` — Übersichts-Wrapper für die Abhak-Liste
- `habit-tiles.tsx` / `.css` — vier Kennzahl-Kacheln auf der Routinen-Seite
- `habit-table.tsx` / `habit-week-grid.tsx` / `row-month-nav.tsx` / `.css` — ausklappbare Tabelle mit Monatsraster je Zeile
- `habit-history-card.tsx` / `.css` / `step-path.ts` / `legend-order.ts` — 30-Tage-Verlaufskarte, Legende platzsparend
- `use-archive-habit.ts` / `habit-editor.tsx` / `.css` / `add-habit-fab.tsx` — Archiv, Anlegen/Bearbeiten per Sheet und FAB
