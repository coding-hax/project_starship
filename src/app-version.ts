/**
 * The build identifier this client was bundled with (#1235 AK4) — the same
 * value the server compares against (`process.env.VERCEL_GIT_COMMIT_SHA`,
 * `src/app/api/health/route.ts`). `NEXT_PUBLIC_*` env vars are inlined at
 * build time, so this is static per deployment, not read at request time.
 *
 * `null` when Vercel's "System Environment Variables" option is off, or in
 * dev/e2e where neither var is set — `src/local/sync.ts` then sends no
 * `X-App-Version` header at all, a safe degradation (the "anderer Stand"
 * counter just stays 0), never an error.
 */
export const APP_VERSION = process.env.NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA ?? null;
