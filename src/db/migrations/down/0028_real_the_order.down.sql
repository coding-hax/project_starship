-- Down path for 0028_real_the_order.sql (#1202, S3).
-- invites is server-infra like sessions/auth_challenges/recovery_codes — no
-- account data lives here, so dropping it loses nothing but outstanding,
-- unredeemed invite links.
ALTER TABLE "auth_challenges" DROP COLUMN "invite_id";
DROP TABLE "invites";
