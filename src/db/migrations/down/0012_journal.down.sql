-- Down path for 0012_sweet_impossible_man.sql (issue #338).
-- journal_entries/journal_keys are synchronised tables like reminder_prefs, FK-free —
-- dropping both is safe on its own, order does not matter.
DROP TABLE "journal_entries";
DROP TABLE "journal_keys";
