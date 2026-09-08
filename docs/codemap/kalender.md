# Code-Karte: Kalender & Termine (`src/features/events`)

- `event-time.ts` — reine Layout-Logik: Tages-, Wochen-, Monats-Helfer
- `recurrence.ts` — reine Serien-Expansion: Vorkommen pro Tag, Ausnahmen, Occurrences
- `event-mutations.ts` — Schreibseite zu `recurrence.ts`: kürzen, verschieben, absagen, teilen
- `use-events.ts` — Event-View + Live-Query; unterscheidet synced von abonnierten Terminen
- `use-event-exceptions.ts` — Ausnahme-View, nur lesend — Schreiben über `event-mutations.ts`
- `ics-parse.ts` — Minimal-RFC-5545-Parser, nur ganztägig; getimte Termine fallen heraus
- `ics-expand.ts` — Serien-Expansion für abonnierte Kalender, mit Staleness-Grenze
- `use-ics-subscriptions.ts` — Wetter-Muster: Live-Query, Refresh nur bei Staleness
- `calendar-view.tsx` / `.css` — /kalender: Wochenstreifen, Monat im Rumpf, Agenda + FAB
- `calendar-strip.tsx` / `.css` — Wochenstreifen Mo–So, Wisch blättert, „Heute"-Sprung
- `month-grid.tsx` / `.css` — Monatskarte: scrollende Wochenzeilen, gedeckelte Punkte/Bänder
- `event-agenda.tsx` / `.css` — Ganztägig-Band + Agenda, Uhrzeit-Pille in Kategoriefarbe
- `event-detail.tsx` / `event-editor.tsx` — Detail-Sheet, „Bearbeiten" öffnet den Editor
- `recurrence-scope-sheet.tsx` / `.css` — Scope-Abfrage: dieser, alle folgenden, ganze Serie
- `use-delete-event.ts` — Tombstone + Undo-Fenster für einen Termin
- `events-overview-section.tsx` / `.css` — „Nächster Termin": bis zu 3 Folgezeilen
