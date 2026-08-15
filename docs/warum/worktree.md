# Warum jeder Lauf einen eigenen Worktree bekommt

Die Regel steht in `CLAUDE.md`, Abschnitt „Bevor du anfängst". Hier steht, was
passiert, wenn man sie bricht — beides ist wirklich passiert.

## Der Vorfall #196 (26.07.26): ein HEAD, mehrere Läufe

Es arbeiten mehrere Läufe gleichzeitig im selben Repo: der Runner mit seinen
Slots, parallele Terminal-Sitzungen, Chat-Sitzungen. Ein geteilter Checkout hat
genau **einen** `HEAD` — wer darin den Branch wechselt, zieht ihn allen anderen
unter den Füßen weg.

Am 26.07.26 baute der Runner das Ticket #196 im Haupt-Checkout, der zu diesem
Zeitpunkt auf `fix/232-fab-icon-size` stand. Die komplette Runner-Arbeit landete
in einem Commit mit der Nachricht „increase FAB icon font-size" und wäre über
den Icon-PR halbfertig nach `main` gemerged worden.

Bemerkenswert daran ist nicht der Fehler, sondern wie **unsichtbar** er war: Der
Lauf war grün, der PR sah gesund aus, der Diff war plausibel. Nur der Betreff
passte nicht zum Inhalt — und Betreffzeilen liest beim Merge niemand so genau.
Deshalb ist „nicht im Haupt-Checkout bauen" keine Ordnungsregel, sondern die
einzige Stelle, an der dieser Fehler überhaupt abfangbar ist.

## Der Vorfall #606 (10.08.26): der Install, der den Runner still tötet

`bootstrap_worktree()` in `scripts/claude-runner.sh` verlinkt
`worktree/node_modules` per Symlink auf den Haupt-Checkout, damit im Worktree
überhaupt kein Install nötig ist.

Läuft `pnpm install` mit cwd **im Worktree**, schreibt pnpm dessen
Top-Level-Links relativ zum Worktree-Pfad. Nach `git worktree remove` zeigen
diese Links ins Leere — im Haupt-Checkout.

Der Runner stirbt daran still. `node_modules/.bin/tsx` bleibt als Datei
bestehen, `ts_run()` bekommt also Exit 1 statt Exit 127, und der laute Pfad für
„Kommando nicht gefunden" feuert nie. Deshalb prüft `require_resolvable_tsx()`
heute direkt gegen `node_modules/tsx/package.json` statt nur gegen die Existenz
von `node_modules`.

Reparatur, falls es doch passiert: `CI=true pnpm install --prefer-offline` **im
Haupt-Checkout**.

## Warum `git worktree remove` und nicht `rm -rf`

`rm -rf` löscht das Verzeichnis, aber nicht Gits Verwaltungseintrag unter
`.git/worktrees/`. Der bleibt als Leiche liegen, taucht in `git worktree list`
auf und blockiert, den Pfad später erneut zu benutzen. `git worktree remove`
räumt beides ab.

## Warum absolute Pfade

Ein relativer Pfad in `git worktree add` legt den Worktree **mitten ins Repo**
und blockiert dort stumm jedes weitere `git`-Kommando. Der Fehler ist beim
Anlegen nicht sichtbar und fällt erst auf, wenn nichts mehr geht.

## Warum ein gestagter Index das Schlimmste ist, was man liegen lässt

Ein liegen gebliebener Index ist keine Unordnung, sondern eine geladene Waffe.

`git checkout -- .` und `git clean -fd` fassen die Staging-Area **nicht** an. Ein
gestagter Stand überlebt also jedes Aufräumen, das man üblicherweise für
gründlich hält, und wird beim nächsten Commit in diesem Worktree stillschweigend
mitgeschrieben — inklusive der Rücknahme von Arbeit, die inzwischen längst über
`main` gemergt wurde.

Besonders perfide ist der Fall nach einem Catch-up-Merge: Dort steht gestaged
der **Revert** des `main`-Merges. Wer das nicht bemerkt, macht mit dem nächsten
Commit den halben Merge rückgängig und blockiert obendrein den nächsten
Catch-up.

Deshalb vor dem Verlassen jedes Worktrees: `git status --short`. Steht das `M` in
der **vorderen** Spalte, ist der Index dreckig.
