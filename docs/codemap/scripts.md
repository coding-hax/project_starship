# Code-Karte: Runner, CI, Workflows

## scripts/

- `claude-runner.sh` / `runner/cli.ts` / `runner/*.test.ts` — Bash-Einstieg+TS-Dispatcher, Vitest-Suiten
- `runner/{gh,git,state,clock,time}.ts` — Adapter, injizierbar für Vitest
- `runner/{queue,tier,escalation,cap,pr,catchup}.ts` — Queue, Eskalation, Deckel, PR-Zustand
- `runner/{watch,select,status,ak}.ts` — CI-Wache, Ticketauswahl, Status, AK-Parser
- `runner/{prompts,round}.ts` — die Prompts + eine Runde je Takt
- `runner/{session,shim,cleanup,claim,fleet}.ts` — Session, Shim-Drift, Aufräumen, Multi-Slot
- `check-{test-integrity,sync-invariants}.sh` — abgeschwächte Tests, API außerhalb der Outbox
- `check-tenant-isolation.sh` — Mandanten-PK, requireUser je Route
- `check-{dexie-bump,codemap}.sh` — Dexie-Bump-Hinweis, Karten-Wächter
- `git-hooks/pre-push` / `tests/*.test.sh` — Slot-Claim-Guard; Bash-Fixture-Suiten
- `claude-hooks/post-edit-checks.sh` — PostToolUse-Hook: check-*.sh beim Editieren
- `claude-hooks/pre-bash-guard.mjs` / `claude-hooks/stop-guard.sh` — sperrt --edit-last, Haupt-Checkout, pnpm i
- `starship-runner` — Shim für launchd/systemd
- `bootstrap-github.sh` / `vercel-build.sh` / `smoke-decide.sh` — Setup, Migration, Smoke
- `bootstrap-admin.ts` — einmaliger Admin + erster Einladungs-Link
- `{launchd,systemd}-setup.md` / `gen-slot-plists.sh` — Runner als Dienst je Slot

## .github/workflows/

- `ci.yml` / `guards.yml` — Lint/Typecheck/Vitest/Playwright, Test-Integrity-Gate
- `smoke.yml` / `reminders.yml` — Post-Deploy-Smoke (Auto-Revert); Cron Push-Reminder
- `backup.yml` — nächtlicher pg_dump der DB, Secrets-gated, generisches Upload-Ziel
