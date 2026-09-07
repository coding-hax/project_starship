-- Down path for 0023_silky_kitty_pryde.sql (issue #1102).
-- device_id labels which browser profile a session was opened from. Dropping it
-- returns the login sweep to its pre-#1102 reach: every other session of the
-- same credential, which for a keychain-synced passkey means the other device.
ALTER TABLE "sessions" DROP COLUMN "device_id";
