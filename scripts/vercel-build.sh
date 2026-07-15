#!/usr/bin/env bash
# Release-Schritt für Vercel: Vercel führt "vercel-build" statt "build" aus, wenn
# vorhanden. Migrationen laufen hier, bevor next build läuft — schlägt eine
# Migration fehl, bricht das Skript ab (set -e) und next build läuft nicht mehr.
# Vercel promotet einen fehlgeschlagenen Build nie: die alte Version bleibt live,
# kein Rollout mit halbem Schema (#28).
#
# Nur für Production: Preview-Deployments haben aktuell keine eigene DATABASE_URL,
# das Gating verhindert, dass jeder PR-Preview-Build daran bricht.
set -euo pipefail

if [ "${VERCEL_ENV:-}" = "production" ]; then
  echo "vercel-build: production deploy, running pending migrations…"
  pnpm db:migrate
else
  echo "vercel-build: not a production deploy (VERCEL_ENV=${VERCEL_ENV:-unset}), skipping migrations."
fi

pnpm exec next build --webpack
