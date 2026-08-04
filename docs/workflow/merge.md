# Merge: Claude hebt seinen PR selbst aus dem Entwurf (#147, #167)

Claude wartet nicht mehr selbst auf CI. Existiert für das Ticket noch kein
PR, öffnet der erste Push einen **Draft**-PR (`gh pr create --draft --fill
--title "… — Closes #<nr>"`); Folgeläufe pushen auf denselben Branch, kein
zweiter PR. Weder `gh pr checks --watch` noch ein voller `pnpm e2e`-Lauf
kommen im Bau-Auftrag noch vor; die schnellen Tore (`pnpm lint`,
`pnpm typecheck`, `pnpm test`) laufen weiterhin lokal vor dem Push.

**Unmittelbar vor dem finalen Push zieht Claude `main` proaktiv nach
(#191)**, statt das erst einen Takt später `pr_catch_up_behind()` reaktiv
erledigen zu lassen: `git fetch origin main` + `git merge origin/main
--no-edit` — vorausgesetzt, der Arbeitsbaum ist sauber (alles committet,
nie in einen unsauberen Baum mergen). Klappt der Merge, wird normal
weitergepusht; ein PR entsteht dadurch in aller Regel schon aktuell.
Kollidiert er inhaltlich, löst Claude den Konflikt direkt auf dem eigenen
Branch auf (voller Kontext der eigenen Änderungen) und pusht die Auflösung
mit — kein separater, kalt einsteigender Fix-Lauf. `pr_catch_up_behind()`
bleibt unverändert als Netz bestehen: merged ein anderer PR erst in den
Sekunden nach diesem Push, greift der Runner-Takt wie gehabt nach.

**Endet der Bau-Lauf sauber** (Ticket fertig oder Fortsetzung erfolgreich
gepusht — nicht über eine offene Frage), hebt Claude den PR **selbst** aus
dem Entwurf und aktiviert Auto-Merge, bevor der Lauf endet:
`gh pr ready` + `gh pr merge --squash --auto --delete-branch --subject
"$(gh pr view --json title -q .title)" --body ""` (ohne PR-Nummer — wirkt
auf den PR des aktuellen Branches). Das `--subject` ist Pflicht: bei genau
einem Commit auf dem Branch nimmt GitHub sonst dessen Commit-Nachricht statt
des PR-Titels als Squash-Betreff — ein nur im Titel stehendes `Closes #N`
ginge verloren und das Issue bliebe trotz sauber gemergtem PR offen (#292).
Das setzt nicht
voraus, dass CI schon grün ist: Auto-Merge greift ohnehin erst, wenn alle
Required Checks durch sind, GitHub liefert diese Zusicherung, nicht Claudes
Einschätzung. **Ein Entwurf bedeutet ab jetzt: der Lauf ist nicht sauber zu
Ende gekommen** (Notbremse, Limit, harter Fehler) — nicht mehr „es hat noch
niemand hingeschaut". Bei einer offenen Frage (`needs-answer`) endet der Lauf
bewusst **vor** diesem Schritt, der PR bleibt Entwurf.


**Branch-Schutz auf `main` (zwingend einzurichten, sonst hängt alles in der Luft):**

```bash
gh api -X PUT repos/:owner/:repo/branches/main/protection \
  -F required_status_checks.strict=true \
  -f 'required_status_checks.contexts[]=quality' \
  -f 'required_status_checks.contexts[]=e2e' \
  -f 'required_status_checks.contexts[]=test-integrity' \
  -F enforce_admins=false \
  -F required_pull_request_reviews=null \
  -F restrictions=null
gh repo edit --enable-auto-merge --enable-squash-merge --delete-branch-on-merge
```

## Ein Wächter

**Ein Wächter macht den Auto-Merge erst vertretbar:**

- `test-integrity` — lehnt jeden PR ab, der Tests entfernt, abschaltet
  (`.skip`, `.only`) oder mit `waitForTimeout` grün macht. Reine Textprüfung,
  kein Modell beteiligt.

**`protected-paths` gibt es nicht mehr** (#283). Der Weg dorthin in zwei
Schritten: Mit #276 hörte der Check auf zu blockieren — die PRs werden ohnehin
direkt freigegeben, das Label `human-approved` erzeugte keinen zusätzlichen
Blick auf den Diff, sondern nur einen zusätzlichen Handgriff, der regelmäßig
zur eigentlichen Bremse wurde (Label am PR statt am Issue, zwei gleichzeitige
Check-Suites, Tickets tagelang still). Übrig blieb ein Job, der auflistete, was
ein PR anfasst, und danach immer grün war. Ein Check, der nie fehlschlägt,
bringt niemandem etwas bei — und war trotzdem ein Required Check, der bei jedem
PR einen Runner belegte. Also weg, samt dem toten Zweig im Runner-Kern.

**Der ausgesprochene Preis:** Ein unbeaufsichtigter Lauf kann eine Migration,
eine Krypto-Änderung oder einen Sync-Fix allein mergen. Was bleibt, ist kein
Tor, sondern eine Pflicht — der Bau-Prompt verlangt bei `src/db/`,
`src/crypto/`, `src/local/`, `src/app/api/sync/`, allem mit `auth` im Namen,
`.github/` und `scripts/` einen **Kommentar am Ticket**: was geändert wurde,
warum, was schiefgehen könnte. Die übrigen Netze sind `schema-drift`, `quality`
(Sync-Invarianten), `test-integrity`, `e2e-offline`, `e2e-shipped` und die
Review-Rolle `db-migration`.

**Der bewusst in Kauf genommene Preis:** ein unbeaufsichtigter Runner-Lauf
kann eine Migration, eine Krypto-Änderung oder einen Sync-Eingriff selbst
mergen, ohne dass ein Mensch draufgesehen hat. Die verbleibenden Netze sind
`schema-drift`, `quality` (Sync-Invarianten), `test-integrity`, `e2e-offline`,
`e2e-shipped` und die `db-migration`-Review-Rolle. Wer das zurückdrehen will,
ändert `.github/workflows/guards.yml` — die Pfadliste steht dort unverändert.

Damit merged Claude alles ohne dich.

**Wie ein Ticket geschlossen wird — und wie nicht (#172).** Ein Squash-Merge
schließt in GitHub automatisch jedes Ticket, dessen `Closes #N` irgendwo in
der zusammengefassten Commit-Nachricht auftaucht. Ohne eigene Angabe sammelt
GitHub dafür **alle** Commit-Nachrichten des Branches ein — nicht nur den
PR-Titel. Zieht ein Branch beim Nachziehen von `main` (#160) fremde
Merge-Commits mit (z. B. von PR #165/#166), landen deren `Closes #N` mit im
Squash und schließen ein Ticket, dessen eigener PR noch gar nicht gemergt
ist — beobachtet an #163, fälschlich geschlossen durch den Squash von PR
#168, während #163s eigentlicher PR #166 noch offen war. Weil die
Ticketauswahl nur offene Issues kennt, wäre so ein Ticket sonst für immer
verloren.

Zwei Mechanismen verhindern das:

- **Eigenes Subject/Body** (`prSquashMerge()` in `scripts/runner/pr.ts`):
  Jeder Squash-Merge, den der Runner auslöst, übergibt `--subject` (den
  PR-Titel) und ein leeres `--body` explizit — GitHub sammelt dann nichts
  mehr selbst ein. Ein Ticket schließt **nur**, wenn sein eigener PR-Titel
  `Closes #N` trägt.
- **Netz** (`reopenFalselyClosedIssues()`): Vor jeder Ticketauswahl prüft
  der Runner alle offenen PRs mit `Closes #N` im Titel. Ist das referenzierte
  Ticket trotzdem `CLOSED`, kann dieser (noch offene) PR es nicht gewesen
  sein — der Runner öffnet das Ticket wieder und kommentiert den Grund samt
  PR-Nummer.

Der bestehende Merge-Weg (`--squash --auto --delete-branch`) bleibt dabei
unverändert; Auto-Merge wird nicht durch einen manuellen Merge ersetzt.
Abgedeckt in `scripts/tests/squash-close-guard.test.sh`.
