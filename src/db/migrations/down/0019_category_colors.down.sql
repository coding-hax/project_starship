-- Down path for 0019_romantic_king_cobra.sql (issue #660).
-- category_colors is a synchronised table like reminder_prefs, and nothing
-- references it (no FK) — dropping it only loses the chosen overrides, the
-- `--cat-*` defaults from tokens.css take over again (AC5).
DROP TABLE "category_colors";
