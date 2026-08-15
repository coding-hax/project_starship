-- Down path for 0020_clumsy_chimera.sql (issue #755).
-- auth_rate_limits is server-infra like sessions/auth_challenges — no FK, not
-- sync-managed — dropping it only loses the current window counters, the
-- limiter fails open on the next request until a new row accrues.
DROP TABLE "auth_rate_limits";
