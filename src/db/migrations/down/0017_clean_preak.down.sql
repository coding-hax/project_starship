-- Down path for 0017_clean_preak.sql (issue #476).
-- Drops the FK along with the column; recovery-code registration falls back
-- to the pre-#476 single-phase burn (no data other than this link is lost).
ALTER TABLE "auth_challenges" DROP CONSTRAINT "auth_challenges_recovery_code_id_recovery_codes_id_fk";
ALTER TABLE "auth_challenges" DROP COLUMN "recovery_code_id";
