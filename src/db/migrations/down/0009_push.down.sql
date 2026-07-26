-- Down path for 0009_nosy_scorpion.sql (issue #122).
-- drizzle-kit only ever generates and applies "up" migrations — this file follows the
-- `migrations/down/` convention established by #186 and is applied by hand if #122
-- needs to be rolled back. push_subscriptions is device infrastructure like sessions:
-- nothing references it (no FK, not sync-managed), so dropping it is safe on its own.
DROP TABLE "push_subscriptions";
