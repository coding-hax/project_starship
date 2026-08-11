import { describe, expect, it } from 'vitest';
import { parseIcs } from './ics-parse';

function ics(...lines: string[]): string {
  return lines.join('\r\n');
}

describe('parseIcs', () => {
  it('parses a single all-day event', () => {
    const events = parseIcs(
      ics(
        'BEGIN:VCALENDAR',
        'BEGIN:VEVENT',
        'UID:holiday-1',
        'SUMMARY:Neujahr',
        'DTSTART;VALUE=DATE:20260101',
        'DTEND;VALUE=DATE:20260102',
        'END:VEVENT',
        'END:VCALENDAR',
      ),
    );

    expect(events).toEqual([
      { uid: 'holiday-1', title: 'Neujahr', startDate: '2026-01-01', endDate: '2026-01-02', rrule: undefined, exDates: [] },
    ]);
  });

  it('defaults endDate to startDate when DTEND is missing', () => {
    const events = parseIcs(
      ics('BEGIN:VEVENT', 'UID:x', 'SUMMARY:Eintägig', 'DTSTART;VALUE=DATE:20260305', 'END:VEVENT'),
    );

    expect(events[0].startDate).toBe('2026-03-05');
    expect(events[0].endDate).toBe('2026-03-05');
  });

  it('unfolds a continuation line (leading space is the fold marker, not content)', () => {
    // RFC 5545 §3.1: unfolding drops the CRLF *and* the single leading
    // whitespace that marks the continuation — "lan" + "ger Titel", not
    // "lan" + " ger Titel".
    const events = parseIcs(
      ics('BEGIN:VEVENT', 'UID:folded-1', 'SUMMARY:Ein lan', ' ger Titel', 'DTSTART;VALUE=DATE:20260101', 'END:VEVENT'),
    );

    expect(events[0].title).toBe('Ein langer Titel');
  });

  it('unescapes TEXT values', () => {
    const events = parseIcs(
      ics('BEGIN:VEVENT', 'UID:x', 'SUMMARY:A\\, B\\; C\\nD', 'DTSTART;VALUE=DATE:20260101', 'END:VEVENT'),
    );

    expect(events[0].title).toBe('A, B; C\nD');
  });

  it('skips a timed DTSTART (no VALUE=DATE)', () => {
    const events = parseIcs(
      ics('BEGIN:VEVENT', 'UID:timed', 'SUMMARY:Meeting', 'DTSTART:20260101T090000Z', 'END:VEVENT'),
    );

    expect(events).toEqual([]);
  });

  it('skips a DTSTART with TZID', () => {
    const events = parseIcs(
      ics(
        'BEGIN:VEVENT',
        'UID:tzid',
        'SUMMARY:Meeting',
        'DTSTART;TZID=Europe/Berlin:20260101T090000',
        'END:VEVENT',
      ),
    );

    expect(events).toEqual([]);
  });

  it('ignores unknown properties and components', () => {
    const events = parseIcs(
      ics(
        'BEGIN:VTIMEZONE',
        'TZID:Europe/Berlin',
        'END:VTIMEZONE',
        'BEGIN:VEVENT',
        'UID:x',
        'SUMMARY:Test',
        'DESCRIPTION:wird überlesen',
        'DTSTART;VALUE=DATE:20260101',
        'GEO:52.5;13.4',
        'END:VEVENT',
      ),
    );

    expect(events).toEqual([
      { uid: 'x', title: 'Test', startDate: '2026-01-01', endDate: '2026-01-01', rrule: undefined, exDates: [] },
    ]);
  });

  it('drops an event with no UID', () => {
    const events = parseIcs(ics('BEGIN:VEVENT', 'SUMMARY:Ohne UID', 'DTSTART;VALUE=DATE:20260101', 'END:VEVENT'));
    expect(events).toEqual([]);
  });

  it('parses EXDATE (single and multi-value)', () => {
    const events = parseIcs(
      ics(
        'BEGIN:VEVENT',
        'UID:series',
        'SUMMARY:Serie',
        'DTSTART;VALUE=DATE:20260101',
        'RRULE:FREQ=DAILY;INTERVAL=1',
        'EXDATE;VALUE=DATE:20260102,20260103',
        'EXDATE;VALUE=DATE:20260105',
        'END:VEVENT',
      ),
    );

    expect(events[0].exDates).toEqual(['2026-01-02', '2026-01-03', '2026-01-05']);
  });

  it('maps RRULE FREQ/INTERVAL/COUNT/UNTIL/BYDAY onto the app Recurrence shape', () => {
    const events = parseIcs(
      ics(
        'BEGIN:VEVENT',
        'UID:weekly',
        'SUMMARY:Wöchentlich',
        'DTSTART;VALUE=DATE:20260105',
        'RRULE:FREQ=WEEKLY;INTERVAL=2;COUNT=5;BYDAY=MO,WE',
        'END:VEVENT',
      ),
    );

    expect(events[0].rrule).toEqual({ freq: 'weekly', interval: 2, count: 5, byWeekday: [0, 2] });
  });

  it('maps RRULE UNTIL to a date key', () => {
    const events = parseIcs(
      ics(
        'BEGIN:VEVENT',
        'UID:until',
        'SUMMARY:Bis',
        'DTSTART;VALUE=DATE:20260101',
        'RRULE:FREQ=DAILY;UNTIL=20260201T000000Z',
        'END:VEVENT',
      ),
    );

    expect(events[0].rrule).toEqual({ freq: 'daily', interval: 1, until: '2026-02-01' });
  });

  it('falls back to a single event when FREQ is not representable', () => {
    const events = parseIcs(
      ics('BEGIN:VEVENT', 'UID:secondly', 'SUMMARY:x', 'DTSTART;VALUE=DATE:20260101', 'RRULE:FREQ=SECONDLY', 'END:VEVENT'),
    );

    expect(events[0].rrule).toBeUndefined();
  });

  it('strips a leading ordinal from BYDAY tokens', () => {
    const events = parseIcs(
      ics(
        'BEGIN:VEVENT',
        'UID:x',
        'SUMMARY:x',
        'DTSTART;VALUE=DATE:20260101',
        'RRULE:FREQ=MONTHLY;BYDAY=1MO,-1FR',
        'END:VEVENT',
      ),
    );

    expect(events[0].rrule?.byWeekday).toEqual([0, 4]);
  });

  it('parses multiple VEVENTs', () => {
    const events = parseIcs(
      ics(
        'BEGIN:VEVENT',
        'UID:a',
        'SUMMARY:A',
        'DTSTART;VALUE=DATE:20260101',
        'END:VEVENT',
        'BEGIN:VEVENT',
        'UID:b',
        'SUMMARY:B',
        'DTSTART;VALUE=DATE:20260102',
        'END:VEVENT',
      ),
    );

    expect(events.map((event) => event.uid)).toEqual(['a', 'b']);
  });
});
