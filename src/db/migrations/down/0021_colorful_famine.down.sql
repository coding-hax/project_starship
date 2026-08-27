-- Down path for 0021_colorful_famine.sql (issue #854).
-- credential_id is a nullable FK column added to sessions — dropping it removes
-- only the device binding, never any row. Dropping the column also drops its FK
-- constraint (sessions_credential_id_credentials_id_fk) automatically.
ALTER TABLE "sessions" DROP COLUMN "credential_id";
