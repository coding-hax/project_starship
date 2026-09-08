# Code-Karte: Kalender & Termine (`src/features/events`)

- `event-time.ts` — reine Layout-Logik: Tages-, Wochen-, Monats-Helfer
- `recurrence.ts` — reine Serien-Expansion: Vorkommen pro Tag, Ausnahmen
- `event-mutations.ts` — Schreibseite zu `recurrence.ts`: kürzen, verschieben, absagen, teilen
- `use-events.ts` — Event-View + Live-Query, synced vs. abonnierte Termine
- `use-event-exceptions.ts` — Ausnahme-View, nur lesend — Schreiben über `event-mutations.ts`
- `ics-parse.ts` — Minimal-RFC-5545-Parser, nur ganztägig; getimte Termine fallen heraus
- `ics-expand.ts` — Serien-Expansion abonnierter Kalender, Staleness-Grenze
- `use-ics-subscriptions.ts` — Wetter-Muster: Live-Query, Refresh bei Staleness
- `calendar-view.tsx` / `.css` — /kalender: Wochenstreifen, Monat im Rumpf, Agenda + FAB
- `calendar-strip.tsx` / `.css` — Wochenstreifen Mo–So, Wisch blättert, „Heute"-Sprung
- `month-grid.tsx` / `.css` — Monatskarte: scrollende Wochenzeilen, gedeckelte Punkte/Bänder
- `event-agenda.tsx` / `.css` — Ganztägig-Band + Agenda, Uhrzeit-Pille in Kategoriefarbe
- `event-detail.tsx` / `.css` / `event-editor.tsx` / `.css` — Detail-Sheet, „Bearbeiten" öffnet den Editor
- `recurrence-scope-sheet.tsx` / `.css` — Scope-Abfrage: dieser, alle folgenden, ganze Serie
- `use-delete-event.ts` — Tombstone + Undo-Fenster je Termin
- `events-overview-section.tsx` / `.css` — „Nächster Termin": bis zu 3 Folgezeilen
