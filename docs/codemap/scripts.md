# Code-Karte: Runner, CI, Workflows

## scripts/

- `garmin-bootstrap.md` / `claude-runner.sh` / `runner/cli.ts` / `runner/*.test.ts` — OAuth1-Handgriff; Bash-Einstieg+TS-Dispatcher, Vitest-Suiten
- `runner/{gh,git,state,clock,time}.ts` — Adapter, injizierbar für Vitest
- `runner/{queue,tier,escalation,cap,pr,catchup}.ts` — Queue, Eskalation, Deckel, PR-Zustand
- `runner/{watch,select,status,ak}.ts` — CI-Wache, Ticketauswahl, Status, AK-Parser
- `runner/{prompts,round}.ts` — die Prompts + eine Runde je Takt
- `runner/{session,shim,cleanup,claim,fleet}.ts` — Session, Shim-Drift, Aufräumen, Multi-Slot
- `check-{test-integrity,sync-invariants}.sh` — abgeschwächte Tests, API außerhalb der Outbox
- `check-{dexie-bump,codemap}.sh` — Dexie-Bump-Hinweis, Wächter für diese Karten
- `git-hooks/pre-push` / `tests/*.test.sh` — Slot-Claim-Guard; Bash-Fixture-Suiten
- `starship-runner` — Shim, den launchd/systemd startet
- `bootstrap-github.sh` / `vercel-build.sh` / `smoke-decide.sh` — Setup, Migration, Post-Deploy-Smoke
- `{launchd,systemd}-setup.md` / `gen-slot-plists.sh` — Runner als Dienst je Slot

## .github/workflows/

- `ci.yml` / `guards.yml` — Lint/Typecheck/Vitest/Playwright, Test-Integrity-Gate
- `smoke.yml` / `garmin-sync.yml` / `reminders.yml` — Post-Deploy-Smoke (Auto-Revert); Cron Garmin-Sync/Push-Reminder
