// Zeit/Limit-Funktionen, portiert aus claude-runner.sh (#199, S2 von #184).
// Aktuelle Zeit kommt ausschliesslich ueber den `clock`-Adapter aus S1 --
// niemals `Date.now()`/`new Date()` direkt, damit Vitest deterministisch bleibt.
//
// Laeuft auf demselben Rechner wie die bisherige Bash-Implementierung, also in
// derselben Locale (C -> englische Kuerzel) und Zeitzone wie `date`. Beides
// wird hier bewusst NICHT konfigurierbar gemacht, sonst waere Zeichengleichheit
// zur Bash-Ausgabe nicht mehr garantiert.
import type { Clock } from './clock.js';

const WEEKDAY_ABBR = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTH_ABBR = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];
const MONTH_NAME_TO_INDEX: Record<string, number> = Object.fromEntries(
  MONTH_ABBR.map((name, index) => [name.toLowerCase(), index]),
);

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

// Kleiner strftime-Ausschnitt -- nur die Platzhalter, die fmt_hm/d_plus je
// gebraucht haben. Kein Vollausbau auf Vorrat (siehe #184 Nicht-Ziele).
function formatDate(date: Date, format: string): string {
  const tokens: Record<string, string> = {
    '%Y': String(date.getFullYear()),
    '%m': pad2(date.getMonth() + 1),
    '%d': pad2(date.getDate()),
    '%H': pad2(date.getHours()),
    '%M': pad2(date.getMinutes()),
    '%S': pad2(date.getSeconds()),
    '%a': WEEKDAY_ABBR[date.getDay()],
    '%b': MONTH_ABBR[date.getMonth()],
  };
  return format.replace(/%[a-zA-Z]/g, (token) => tokens[token] ?? token);
}

// Unix-Zeit -> "Mo 14:51", entspricht `date -r "$1" "+%a %H:%M"` bzw.
// `date -d "@$1" "+%a %H:%M"`. `null` bei nicht-numerischer Eingabe -- exakt
// der Fall, in dem beide Bash-Varianten scheitern (leeres stdout, Exit != 0).
export function fmtHm(epochSeconds: number): string | null {
  if (!Number.isFinite(epochSeconds)) return null;
  return formatDate(new Date(epochSeconds * 1000), '%a %H:%M');
}

// Wie fmtHm, aber nur "HH:MM" -- OHNE Wochentag (%a). Der Kontingent-Titel
// (#891, AK2/AK3: "Kontingent leer bis 14:51") schreibt die Uhrzeit woertlich
// ohne Tageskuerzel; fmtHm liefe hier vom AK-Wortlaut ab. `null` bei
// nicht-numerischer Eingabe, exakt wie fmtHm.
export function fmtClock(epochSeconds: number): string | null {
  if (!Number.isFinite(epochSeconds)) return null;
  return formatDate(new Date(epochSeconds * 1000), '%H:%M');
}

// Heute + $1 Tage, formatiert nach $2 -- entspricht `date -v+"$1"d "+$2"` bzw.
// `date -d "+$1 day" "+$2"`. "Heute" kommt aus dem Clock-Adapter, nicht aus
// der Systemuhr direkt.
export function dPlus(days: number, format: string, clock: Clock): string | null {
  if (!Number.isFinite(days)) return null;
  const future = new Date(clock.now().getTime());
  future.setDate(future.getDate() + days);
  return formatDate(future, format);
}

const TIME_RE = /([0-9]{1,2})(?::([0-9]{2}))?(am|pm)/;
const MONTH_RE = /jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec/;
const YEAR_RE = /[0-9]{4}/;

// Liest die Reset-Angabe aus einer Claude-CLI-Meldung, gibt eine Unix-Zeit
// zurueck (oder `null`, wenn sie sich nicht deuten laesst -- Best Effort,
// siehe Kommentar in claude-runner.sh bei reset_epoch()).
export function resetEpoch(text: string, clock: Clock): number | null {
  const txt = text.toLowerCase();
  if (!txt.includes('resets')) return null;
  const now = Math.floor(clock.now().getTime() / 1000);

  // Nur der Teil hinter "resets"; Zeitzone in Klammern fliegt raus.
  let rest = txt.slice(txt.indexOf('resets') + 'resets'.length);
  rest = rest.replace(/\([^)]*\)/g, '');

  const timeMatch = rest.match(TIME_RE);
  if (!timeMatch) return null;
  const hour12 = Number(timeMatch[1]);
  const minute = timeMatch[2] !== undefined ? Number(timeMatch[2]) : 0;
  const meridiem = timeMatch[3];
  let hour24 = hour12 % 12;
  if (meridiem === 'pm') hour24 += 12;

  const monthMatch = rest.match(MONTH_RE);

  if (monthMatch) {
    // Wochenlimit: Datum ist da, also exakt bestimmbar.
    const mon = monthMatch[0];
    const monIdx = MONTH_NAME_TO_INDEX[mon];
    // Letztes Vorkommen von $mon (die Bash-Seite matcht ueber ein gieriges
    // `.*${mon}`, das faengt in "rest" bis zum letzten Treffer vor).
    const afterMon = rest.slice(rest.lastIndexOf(mon) + mon.length);
    const dnumMatch = afterMon.match(/^[^0-9]*([0-9]{1,2})/);
    if (!dnumMatch) return null;
    const day = Number(dnumMatch[1]);
    const yearMatch = rest.match(YEAR_RE);
    const year = yearMatch ? Number(yearMatch[0]) : new Date(clock.now()).getFullYear();

    let tsOut = Math.floor(new Date(year, monIdx, day, hour24, minute, 0).getTime() / 1000);
    tsOut += 60; // eine Minute Puffer
    if (tsOut - now <= 0) return null;
    // Absurd weit weg? Hoechstens 7 Tage am Stueck schlafen, dann neu bewerten.
    if (tsOut - now > 604800) tsOut = now + 604800;
    return tsOut;
  }

  // Session-Limit: nur eine Uhrzeit, kein Datum -> sie liegt <= 24h voraus.
  const today = clock.now();
  let tsOut = Math.floor(
    new Date(today.getFullYear(), today.getMonth(), today.getDate(), hour24, minute, 0).getTime() / 1000,
  );
  // Liegt die Uhrzeit schon hinter uns, ist der Reset nach Mitternacht gemeint.
  if (tsOut <= now) tsOut += 86400;
  tsOut += 60; // eine Minute Puffer
  // Ein Session-Limit setzt nach spaetestens ~5h aus. Alles darueber ist ein
  // altes/fehlgeparstes Ergebnis -> verwerfen statt stundenlang blind schlafen.
  if (tsOut - now > 21600) return null;
  return tsOut;
}
