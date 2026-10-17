#!/usr/bin/env bash
# Wächter für die Mandantentrennung (ADR-0031, #1200). Reine Textprüfung, kein
# Modell — läuft in der CI als Required Check.
#
# Er ersetzt keine Sorgfalt. Er fängt die drei Fehler, die sich beim nächsten Mal
# genauso wiederholen würden, und die alle drei still sind: niemand sieht an der
# Oberfläche, dass eine Tabelle den falschen Primärschlüssel hat oder dass eine
# Route ohne Konto-Prüfung in die Daten greift. Man sieht es erst, wenn jemand
# die Daten einer fremden Person vor sich hat.
set -uo pipefail

SCAN_ROOT="${SCAN_ROOT:-src}"
SCHEMA="${SCHEMA:-$SCAN_ROOT/db/schema.ts}"
FAIL=0

red()  { printf '\033[31m✗ %s\033[0m\n' "$1"; FAIL=1; }
ok()   { printf '\033[32m✓ %s\033[0m\n' "$1"; }

# --- 1. Jede synchronisierte Tabelle trägt (user_id, id) als Primärschlüssel ---
#
# "Synchronisiert" heißt: der Tabellenblock spreizt `...syncColumns`. Genau diese
# Tabellen brauchen `tenantPrimaryKey(table)` in ihrer Extras-Liste. Gezählt wird
# blockweise über awk, nicht zeilenweise über grep — ein `pgTable(` beginnt den
# Block, die schließende `);` in Spalte 1 beendet ihn.
if [ ! -f "$SCHEMA" ]; then
  red "Schema nicht gefunden: $SCHEMA"
else
  MISSING=$(awk '
    /^export const [A-Za-z]+ = pgTable\(/ { inblock = 1; name = $3; sync = 0; pk = 0 }
    inblock && /\.\.\.syncColumns/        { sync = 1 }
    inblock && /tenantPrimaryKey\(table\)/ { pk = 1 }
    inblock && /^\);/                     { if (sync && !pk) print name; inblock = 0 }
  ' "$SCHEMA")

  if [ -n "$MISSING" ]; then
    echo "$MISSING" | sed 's/^/  /'
    red "Synchronisierte Tabelle ohne tenantPrimaryKey(table) (siehe oben)."
    echo "  Jede Tabelle mit syncColumns trägt (user_id, id) als Primärschlüssel (ADR-0031)."
  else
    ok "Jede synchronisierte Tabelle trägt (user_id, id) als Primärschlüssel."
  fi
fi

# --- 2. Kein requireOwner, kein OWNER_USER_ID ---------------------------------
#
# Beide sind mit #1200 verschwunden. Taucht eines wieder auf, ist jemand beim
# Kopieren einer alten Route in das Ein-Personen-Modell zurückgefallen.
LEGACY=$(grep -rEn "requireOwner|OWNER_USER_ID" "$SCAN_ROOT" \
  --include='*.ts' --include='*.tsx' 2>/dev/null)

if [ -n "$LEGACY" ]; then
  echo "$LEGACY" | sed 's/^/  /'
  red "requireOwner/OWNER_USER_ID ist zurück (siehe oben)."
  echo "  Die Autorisierung läuft über requireUser() aus src/auth/session.ts (ADR-0031)."
else
  ok "Kein requireOwner, kein OWNER_USER_ID."
fi

# --- 3. Jede API-Route mit DB-Zugriff kennt ihr Konto --------------------------
#
# Entweder sie holt es selbst aus der Sitzung (`requireUser`), oder sie ist ein
# Helfer unter app/api/, der es als Parameter (`userId: string`) gereicht
# bekommt — `pull/read-changes-since.ts` ist so einer. Beides ist gebunden; was
# der Wächter sucht, ist die Datei, die auf `@/db` greift und von einem Konto
# überhaupt nichts weiß.
#
# Ausnahmen, jede mit Grund:
#   health/            Liveness-Probe, bewusst offen (SELECT 1 + öffentlicher SHA)
#   auth/status/       entscheidet "Erst-Einrichtung oder Anmelden", vor jeder Sitzung
#   auth/login/        die Anmeldung selbst — hier entsteht die Sitzung erst
#   auth/register/     dito, plus der Erst-Setup-Pfad
#   auth/logout/       beendet die Sitzung, die es prüfen würde
#   push/reminders/    Cron mit Bearer-Secret; prüft requireUser nur für den
#                      Hand-Anstoß und ist dafür in der Datei selbst belegt
ALLOWLIST='app/api/(health|auth/status|auth/login|auth/register|auth/logout)/'

UNGUARDED=""
while IFS= read -r file; do
  case "$file" in
    *"/app/api/"*) ;;
    *) continue ;;
  esac
  echo "$file" | grep -qE "$ALLOWLIST" && continue
  case "$file" in *.test.ts) continue ;; esac
  grep -q "from '@/db'" "$file" || continue
  grep -q "requireUser" "$file" && continue
  grep -qE "userId: string" "$file" && continue
  UNGUARDED="$UNGUARDED$file"$'\n'
done < <(find "$SCAN_ROOT" -name '*.ts' -path '*app/api*' 2>/dev/null)

if [ -n "$UNGUARDED" ]; then
  printf '%s' "$UNGUARDED" | sed 's/^/  /'
  red "API-Route greift auf @/db zu, ohne ein Konto zu kennen (siehe oben)."
  echo "  Entweder requireUser() aus der Sitzung, oder userId als Parameter."
  echo "  Gehört die Route wirklich ohne Sitzung erreichbar zu sein, trägt sie sich mit"
  echo "  Begründung in die Ausnahmeliste dieses Skripts ein."
else
  ok "Jede API-Route mit DB-Zugriff kennt ihr Konto."
fi

exit $FAIL
