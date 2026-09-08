# Code-Karte: Runner, CI, Workflows

## scripts/

- `garmin-bootstrap.md` — Handgriff fürs Garmin-OAuth1-Token
- `claude-runner.sh` / `runner/cli.ts` — Runner: Bash-Einstieg + TS-Dispatcher
- `runner/{gh,git,state,clock,time}.ts` — Adapter, injizierbar für Vitest
- `runner/{queue,tier,escalation,cap,pr,catchup}.ts` — Queue, Eskalation, Deckel, PR-Zustand
- `runner/{watch,select,status,ak}.ts` — CI-Wache, Ticketauswahl, Status, AK-Parser
- `runner/prompts.ts` / `runner/round.ts` — die Prompts + eine Runde je Takt
- `runner/{session,shim,cleanup,claim,fleet}.ts` — Session, Shim-Drift, Aufräumen, Multi-Slot
- `runner/*.test.ts` — Vitest-Suiten der TS-Adapter
- `git-hooks/pre-push` — bricht nur bei fremdem Slot-Claim ab
- `check-test-integrity.sh` / `check-sync-invariants.sh` — abgeschwächte Tests, API außerhalb der Outbox
- `check-dexie-bump.sh` / `check-codemap.sh` — Dexie-Bump-Hinweis, Wächter für diese Karten
- `tests/*.test.sh` — Bash-Fixture-Suiten je Guard/Runner-Baustein
- `starship-runner` — Shim, den launchd/systemd startet
- `bootstrap-github.sh` / `vercel-build.sh` / `smoke-decide.sh` — Setup, Migration, Post-Deploy-Smoke
- `launchd-setup.md` / `systemd-setup.md` / `gen-slot-plists.sh` — Runner als Dienst je Slot

## .github/workflows/

- `ci.yml` / `guards.yml` — Lint/Typecheck/Vitest/Playwright, Test-Integrity-Gate
- `smoke.yml` — Post-Deploy-Smoke gegen Prod, Auto-Revert bei Rot
- `garmin-sync.yml` / `reminders.yml` — Cron für Garmin-Sync und Push-Reminder
