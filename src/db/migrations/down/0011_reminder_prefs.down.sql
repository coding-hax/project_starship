-- Down path for 0011_cute_rachel_grey.sql (issue #244).
-- reminder_prefs is a synchronised table like tasks/habits, but nothing references
-- it (no FK) and it is never read by anything but sendDueReminders() and the
-- settings panel — dropping it is safe on its own.
DROP TABLE "reminder_prefs";
