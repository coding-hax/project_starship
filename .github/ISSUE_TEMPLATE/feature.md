---
name: Feature
about: Ein Ticket, das Claude autonom abarbeiten kann
title: ''
labels: ''
assignees: ''
---

## Ziel

<!-- Ein Satz: was soll danach möglich sein? -->

## Akzeptanzkriterien

<!-- Given/When/Then. Das ist KEIN Prosa-Wunsch, sondern die Spezifikation der
     Playwright-Tests. Was hier nicht steht, wird nicht gebaut. -->

- [ ] Given …, When …, Then …
- [ ] Given ich bin offline, When ich speichere,
      Then erscheint es sofort und die Outbox enthält einen Eintrag.
- [ ] Given ich war offline und werde online, When der Sync läuft,
      Then existiert der Datensatz serverseitig.

## Betroffene Dateien

<!-- Beim Ticketschreiben ausfüllen. Spart dem Agenten die Suche = spart Tokens.
     Siehe docs/CODEMAP.md. -->

- `src/features/…/….tsx` (neu)
- `src/local/outbox.ts` (lesen, nicht ändern)
- `tests/….spec.ts` (erweitern)

## Betroffene Docs

<!-- Welche Docs der Agent lesen MUSS. Die Bau-Rolle liest sonst nur
     CLAUDE.md + docs/CODEMAP.md. Leer lassen, wenn keine nötig. -->

- `docs/ARCHITECTURE.md` (bei Schema/Migration)

## Nicht-Ziele

<!-- Was in diesem Ticket ausdrücklich NICHT passiert. -->

-

## Milestone

<!-- M0 – Fundament | M1 – Aufgaben | M2 – Termine | M3 – Journal
     | M4 – Gewohnheiten | M5 – Heute | M6 – Sprachmemo -->
