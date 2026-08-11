/**
 * Minimal RFC-5545 `.ics` parser (issue #560, ADR-0022) — pure, no DB/DOM/network,
 * Vitest-testable like recurrence.ts. Reads only the subset ADR-0022 documents:
 * `VEVENT`'s `UID`/`SUMMARY`/`DTSTART;VALUE=DATE`/`DTEND;VALUE=DATE`/`RRULE`
 * (`FREQ`/`INTERVAL`/`COUNT`/`UNTIL`/`BYDAY`)/`EXDATE`. Everything else — other
 * properties, other components (`VTIMEZONE`, `VALARM`, …) — is overlesen, never
 * guessed at. Timed events (`DTSTART` with a time-of-day or `TZID`) fall out
 * entirely: ADR-0022 Entscheidung A limits this ticket to all-day events, so
 * there is no timezone arithmetic in here to get wrong.
 */

import type { Recurrence } from './recurrence';

/** One `VEVENT`'s read subset, still unexpanded — `ics-expand.ts` turns `rrule` into instances. */
export interface ParsedIcsEvent {
  uid: string;
  title: string;
  /** Berlin calendar days, `YYYY-MM-DD` (RFC 5545 `VALUE=DATE`, never a timed value here). */
  startDate: string;
  endDate: string;
  rrule?: Recurrence;
  exDates: string[];
}

interface RawProperty {
  name: string;
  params: Record<string, string>;
  value: string;
}

/** RFC 5545 §3.1 line unfolding: a line starting with a space/tab continues the previous one. */
function unfoldLines(text: string): string[] {
  const rawLines = text.split(/\r\n|\r|\n/);
  const lines: string[] = [];
  for (const line of rawLines) {
    if ((line.startsWith(' ') || line.startsWith('\t')) && lines.length > 0) {
      lines[lines.length - 1] += line.slice(1);
    } else if (line.length > 0) {
      lines.push(line);
    }
  }
  return lines;
}

function parseLine(line: string): RawProperty {
  const colonIndex = line.indexOf(':');
  if (colonIndex === -1) return { name: line.toUpperCase(), params: {}, value: '' };
  const head = line.slice(0, colonIndex);
  const value = line.slice(colonIndex + 1);
  const [name, ...paramParts] = head.split(';');
  const params: Record<string, string> = {};
  for (const part of paramParts) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    params[part.slice(0, eq).toUpperCase()] = part.slice(eq + 1);
  }
  return { name: name.toUpperCase(), params, value };
}

/** RFC 5545 §3.3.11 TEXT escaping — `\n`/`\N`, `\,`, `\;`, `\\`, single pass so `\\n` doesn't double-unescape. */
function unescapeText(value: string): string {
  return value.replace(/\\(n|N|,|;|\\)/g, (_match, escaped: string) =>
    escaped === 'n' || escaped === 'N' ? '\n' : escaped,
  );
}

/** `YYYYMMDD` (optionally followed by a time part we ignore) → `YYYY-MM-DD`. */
function formatIcsDate(value: string): string {
  return `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`;
}

const FREQ_MAP: Record<string, Recurrence['freq']> = {
  DAILY: 'daily',
  WEEKLY: 'weekly',
  MONTHLY: 'monthly',
  YEARLY: 'yearly',
};

const BYDAY_MAP: Record<string, number> = { MO: 0, TU: 1, WE: 2, TH: 3, FR: 4, SA: 5, SU: 6 };

/** `null` when `FREQ` isn't one of the four the app's `Recurrence` type supports (e.g. `SECONDLY`) — falls back to a single event, never a guess. */
function parseRrule(value: string): Recurrence | null {
  const parts: Record<string, string> = {};
  for (const pair of value.split(';')) {
    const eq = pair.indexOf('=');
    if (eq === -1) continue;
    parts[pair.slice(0, eq).toUpperCase()] = pair.slice(eq + 1);
  }

  const freq = FREQ_MAP[parts.FREQ ?? ''];
  if (!freq) return null;

  const rrule: Recurrence = { freq, interval: parts.INTERVAL ? Number(parts.INTERVAL) : 1 };

  if (parts.BYDAY) {
    // Strips a leading ordinal ("1MO", "-1FR") — `Recurrence.byWeekday` has no
    // positional concept, only the weekly per-weekday set (recurrence.ts).
    const byWeekday = parts.BYDAY.split(',')
      .map((token) => BYDAY_MAP[token.replace(/^[+-]?\d+/, '').toUpperCase()])
      .filter((day): day is number => day !== undefined);
    if (byWeekday.length > 0) rrule.byWeekday = byWeekday;
  }
  if (parts.UNTIL) rrule.until = formatIcsDate(parts.UNTIL);
  if (parts.COUNT) rrule.count = Number(parts.COUNT);

  return rrule;
}

/** Is this `DTSTART`/`DTEND` a timed value (has a time-of-day or a `TZID`)? Those fall outside ADR-0022 Entscheidung A. */
function isTimedDateProperty(prop: RawProperty): boolean {
  return prop.params.VALUE?.toUpperCase() !== 'DATE' || prop.value.includes('T') || 'TZID' in prop.params;
}

interface EventBuilder {
  uid?: string;
  title?: string;
  startDate?: string;
  endDate?: string;
  rrule?: Recurrence;
  exDates: string[];
  /** Set once a timed `DTSTART`/`DTEND` is seen — the whole event is out of scope, but parsing continues to find `END:VEVENT`. */
  skip: boolean;
}

/** Parses the `VEVENT`s in `text` into their unexpanded, all-day-only form. */
export function parseIcs(text: string): ParsedIcsEvent[] {
  const events: ParsedIcsEvent[] = [];
  let current: EventBuilder | null = null;

  for (const line of unfoldLines(text)) {
    const prop = parseLine(line);

    if (prop.name === 'BEGIN' && prop.value.toUpperCase() === 'VEVENT') {
      current = { exDates: [], skip: false };
      continue;
    }
    if (prop.name === 'END' && prop.value.toUpperCase() === 'VEVENT') {
      if (current && !current.skip && current.uid && current.startDate) {
        events.push({
          uid: current.uid,
          title: current.title ?? '',
          startDate: current.startDate,
          endDate: current.endDate ?? current.startDate,
          rrule: current.rrule,
          exDates: current.exDates,
        });
      }
      current = null;
      continue;
    }
    if (!current || current.skip) continue;

    switch (prop.name) {
      case 'UID':
        current.uid = prop.value;
        break;
      case 'SUMMARY':
        current.title = unescapeText(prop.value);
        break;
      case 'DTSTART':
        if (isTimedDateProperty(prop)) {
          current.skip = true;
          break;
        }
        current.startDate = formatIcsDate(prop.value);
        break;
      case 'DTEND':
        if (isTimedDateProperty(prop)) {
          current.skip = true;
          break;
        }
        current.endDate = formatIcsDate(prop.value);
        break;
      case 'RRULE':
        current.rrule = parseRrule(prop.value) ?? undefined;
        break;
      case 'EXDATE':
        for (const part of prop.value.split(',')) {
          if (part.length >= 8) current.exDates.push(formatIcsDate(part));
        }
        break;
      default:
        break; // überlesen — nicht in der Teilmenge (ADR-0022)
    }
  }

  return events;
}
