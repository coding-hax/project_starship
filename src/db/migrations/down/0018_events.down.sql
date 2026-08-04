-- Down path for 0018_fancy_pestilence.sql (issue #552, S1 of #473).
-- Both tables are purely additive foundation with no reader yet (no route/UI in
-- this stage) — dropping them removes only event/exception rows, never any other
-- table. event_exceptions first: it holds the FK (event_id -> events.id).
DROP TABLE "event_exceptions";
DROP TABLE "events";
