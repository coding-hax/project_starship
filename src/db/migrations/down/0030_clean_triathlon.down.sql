-- Down path for 0030_clean_triathlon.sql (#1205, S6).
-- Additive, verlustfrei umkehrbar: storage_limit_bytes ist nur ein Override,
-- NULL fällt bereits auf den Code-Default zurück (DEFAULT_STORAGE_LIMIT_BYTES,
-- src/db/storage-quota.ts).
ALTER TABLE "users" DROP COLUMN "storage_limit_bytes";
