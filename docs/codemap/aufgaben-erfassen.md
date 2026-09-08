# Code-Karte: Aufgaben + Erfassen

## src/features/tasks

- `task-list.tsx` / `task-list.css` / `tasks-overview-section.tsx` — Liste mit Drag-Drop, Übersichts-Sektion
- `task-item.tsx` — eine Zeile: Checkbox, Swipe erledigen/löschen, Drag-to-Nest
- `use-tasks.ts` / `use-complete-task.ts` / `use-delete-task.ts` — Live-Query+Gruppierung, Erledigen/Löschen mit Undo
- `task-editor.tsx` / `.css` — Bottom-Sheet: Titel, Notiz, Fälligkeit, Priorität
- `quick-add.tsx` / `.css` / `parse-task-input.ts` / `due-picker.tsx` — FAB+Sheet, parst Freitext
- `capture-confirm.tsx` / `.css` — Bestätigungs-Sheet für erkannte Fälligkeit
- `capture-draft-store.ts` — Draft-Item/Batch-Typen, reicht Entwürfe an FAB/Editor weiter
- `uebersicht-capture.tsx` — Erfassungsknopf: lenkt Aufgabe/Termin über den Draft-Store

## src/features/capture

- `types.ts` — Capture-Typen (Kind/Context/Draft/Recognizer)
- `local-recognizer.ts` — Klassifikator je Art, reine Funktion ohne React/Dexie
- `habit-match.ts` — Fuzzy-Match ohne Dependency; eine Verneinung kassiert einen Treffer
- `field-confidence.ts` — Helfer für Feld-Konfidenz, von `quick-add.tsx` geteilt
- `corpus.ts` / `gold/` / `curated.ts` — Satz-Korpora; gold/ ist das Gate über dem Erfassungspfad
- `route-capture.ts` — die eine Stelle für „wohin damit"
