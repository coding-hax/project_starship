#!/usr/bin/env bash
# Decides HEALTHY | REVERT | AMBIGUOUS for the post-deploy smoke (#56).
#
# Pure function, no side effects: reads EXPECTED_SHA, HEALTH_VERSION, HEALTH_OK,
# HEALTH_STATUS, PLAYWRIGHT_RESULT from the environment and writes exactly one
# word to stdout. smoke.yml decides whether to open a revert PR based on that word.
#
# The version-SHA match gates every REVERT: a mismatch (stale CDN, health check hit
# an old instance mid-rollout) must never look like a broken new deploy, or a good
# deploy gets reverted for no reason. Mismatch/missing version -> AMBIGUOUS, never
# REVERT — see scripts/tests/smoke.test.sh, which freezes this guardrail.
set -euo pipefail

expected="${EXPECTED_SHA:-}"
version="${HEALTH_VERSION:-}"
ok="${HEALTH_OK:-false}"
status="${HEALTH_STATUS:-0}"
playwright="${PLAYWRIGHT_RESULT:-fail}"

if [ -z "$expected" ] || [ -z "$version" ] || [ "$version" != "$expected" ]; then
  echo "AMBIGUOUS"
  exit 0
fi

if [ "$ok" = "true" ] && [ "$status" = "200" ] && [ "$playwright" = "pass" ]; then
  echo "HEALTHY"
else
  echo "REVERT"
fi
