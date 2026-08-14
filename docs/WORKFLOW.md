# Workflow

Ticketsystem: **GitHub Issues + GitHub Projects.**
Grund: kostenlos, im selben Repo wie der Code, und über die `gh`-CLI direkt für Claude nutzbar —
kein zweites System, kein Kontextbruch.

Der eigentliche Regeltext lebt seit #446 themenweise in `docs/workflow/`, damit
jede referenzierte Datei klein und gezielt lesbar bleibt (Token-Disziplin,
CLAUDE.md). Diese Datei ist nur noch das Inhaltsverzeichnis:

| Thema | Datei |
| --- | --- |
| Der Zyklus: Issue → research/plan → Branch → PR → Merge, WIP-Limit, Runner-Slots, Worktree, „Wartend ist nicht in Arbeit" | `docs/workflow/zyklus.md` |
| Die Prioritäts-Queue (angepinntes Queue-Issue, Reihenfolge, `blocked-by`) | `docs/workflow/queue.md` |
| Labels — sie steuern den Runner (Tabelle, Kinder-Tickets, „Zwei Arten des Wartens") | `docs/workflow/labels.md` |
| Modell-Eskalation beim Bauen (ADR-0007, `model:*`, Opus-Deckel) | `docs/workflow/eskalation.md` |
| Merge: Draft-PR, Auto-Merge, Branch-Schutz, Wächter, Ticket-Schließen (#172) | `docs/workflow/merge.md` |
| CI-Wache (Runner-Takt): pending/failing/conflict/behind/success | `docs/workflow/ci-wache.md` |
| Aufsicht: wer den Runner heilt, Reise-Modus, Totmann-Schalter (längere Abwesenheit) | `docs/workflow/aufsicht.md` |
| Status/Board, Definition of Ready + Issue-Template, Branch & Commit, CI-Schritte, Migrationen, Playwright-Regeln, was Claude darf, nützliche Befehle | `docs/workflow/ticket-und-tests.md` |

Ein Verweis wie „`docs/workflow/labels.md`, „Zwei Arten des Wartens"" meint: Datei
öffnen, zum benannten Absatz springen — nicht die ganze Datei lesen.
