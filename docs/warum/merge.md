# Warum `--subject` beim Squash-Merge Pflicht ist

Die Regel steht in `CLAUDE.md`, Abschnitt „Am Ende". Hier steht der Grund.

## Der Vorfall #292: das Issue, das trotz gemergtem PR offen blieb

Beim Squash-Merge wählt GitHub den Commit-Betreff nach einer Heuristik: Hat der
Branch **genau einen** Commit, wird dessen Commit-Nachricht als Betreff
übernommen — nicht der PR-Titel.

Das Projekt trägt `Closes #<nr>` aber im **PR-Titel**, nicht in jeder
Commit-Nachricht. Bei einem Ein-Commit-Branch fällt der Schlusssatz damit
lautlos weg: Der PR wird sauber gemerged, der Branch gelöscht, alles sieht
erledigt aus — und das Issue bleibt offen.

Das ist besonders tückisch, weil der Fehler **nichts** rot macht. Kein Check
schlägt an, kein Log meldet etwas. Das Ticket taucht nur später wieder in der
Auswahl auf, als wäre nie daran gearbeitet worden.

Deshalb:

```bash
gh pr merge --squash --auto --delete-branch \
  --subject "$(gh pr view --json title -q .title)" --body ""
```

Das `--subject` erzwingt den PR-Titel als Betreff, unabhängig davon, wie viele
Commits auf dem Branch liegen. Es ist kein Stil, sondern die Absicherung gegen
eine Heuristik, die genau im häufigsten Fall — kleines Ticket, ein Commit —
gegen uns läuft.

## Verwandte Falle: `blocked-by` prüft den PR, nicht das Issue

Aus demselben Grund ist der Zustand eines Vorläufer-Issues kein verlässlicher
Indikator dafür, ob dessen Arbeit in `main` liegt. Ein Issue kann OPEN sein,
obwohl sein PR längst gemerged ist. Wer eine Abhängigkeit prüft, schaut auf den
**PR**, nicht auf den Issue-Status.

Die vollständige Zustandstabelle zum Merge-Ablauf steht in
`docs/workflow/merge.md`.
