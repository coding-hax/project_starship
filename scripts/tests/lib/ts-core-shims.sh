#!/usr/bin/env bash
# Namensbruecke fuer die Bash-Suiten, seit S6 (#203, letzte Stufe von #184).
#
# Bis S5 hatte claude-runner.sh fuer jede portierte Funktion noch einen
# Einzeiler-Wrapper (`tier_current() { ts_run tier-current "$@"; ... }`) plus
# eine `*_bash`-Rueckfallebene. S6 entfernt beides: das Skript ist nur noch
# Einstiegspunkt, die Entscheidungslogik liegt vollstaendig in
# scripts/runner/*.ts.
#
# Die Bash-Suiten rufen diese Funktionen aber namentlich auf. Statt in fuenf
# Dateien hunderte Aufrufstellen umzuschreiben (und dabei Assertions zu
# beruehren, die niemand anfassen sollte), stellt diese Datei die Namen wieder
# her -- jetzt aber als direkter Ruf in den TS-Kern. Die Suiten pruefen damit
# exakt dasselbe Verhalten wie vorher, nur ohne Zwischenschicht.
#
# Voraussetzung: claude-runner.sh ist bereits gesourct (ts_run muss existieren).
# stdout und Exit-Code kommen unveraendert von cli.ts durch -- ts_run leistet
# das schon, deshalb braucht es hier keine Nachbearbeitung.

# Ausgabe-Verhalten wie in den entfernten Wrappern: die Wert-Funktionen geben
# stdout durch, die Befehls-/Praedikat-Funktionen verwerfen es und tragen ihre
# Aussage allein im Exit-Code.
tier_current()                  { ts_run tier-current "$1"; }
tier_bump()                     { ts_run tier-bump "$1" >/dev/null; }
tier_reset()                    { ts_run tier-reset "$1" >/dev/null; }
resume_allowed()                { ts_run resume-allowed "$1" >/dev/null; }
blocker_sig()                   { ts_run blocker-sig "$1"; }
opus_build_cap_reached()        { ts_run opus-cap-reached "$1" "${2:-}" >/dev/null; }
opus_build_cap_reserve()        { ts_run opus-cap-reserve "$1" >/dev/null; }
queue_next()                    { ts_run queue-next "$1" "${2:-}"; }
queue_pending()                 { ts_run queue-pending "$1"; }
queue_order_flat()              { ts_run queue-order-flat "${1:-}"; }
pr_squash_merge()               { ts_run pr-squash-merge "$1" >/dev/null; }
reopen_falsely_closed_issues()  { ts_run reopen-falsely-closed-issues >/dev/null; }

# Sonderfall: liest seine Eingaben aus den Globals der laufenden Runde, nicht
# aus Argumenten -- genau wie der entfernte Wrapper.
build_escalation_eval() {
  ts_run build-escalation-eval \
    "$ISSUE" "$RUN_ROLE" "${LABELS:-}" "${BEFORE_TIP:-}" "${MODEL:-}" >/dev/null
}
