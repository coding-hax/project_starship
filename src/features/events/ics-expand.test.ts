import { describe, expect, it } from 'vitest';
import { expandIcsEvents } from './ics-expand';
import type { ParsedIcsEvent } from './ics-parse';

const HORIZON = { start: '2026-01-01', end: '2026-01-31' };

function event(overrides: Partial<ParsedIcsEvent> & Pick<ParsedIcsEvent, 'uid' | 'startDate'>): ParsedIcsEvent {
  return { title: 'Test', endDate: overrides.startDate, exDates: [], ...overrides };
}

describe('expandIcsEvents', () => {
  it('passes a single event through unchanged when inside the horizon', () => {
    const result = expandIcsEvents([event({ uid: 'a', startDate: '2026-01-10', endDate: '2026-01-11' })], HORIZON);
    expect(result).toEqual([{ uid: 'a', title: 'Test', startDate: '2026-01-10', endDate: '2026-01-11' }]);
  });

  it('drops a single event outside the horizon', () => {
    const result = expandIcsEvents([event({ uid: 'a', startDate: '2025-06-01' })], HORIZON);
    expect(result).toEqual([]);
  });

  it('expands a daily series within the horizon', () => {
    const result = expandIcsEvents(
      [event({ uid: 'daily', startDate: '2026-01-01', rrule: { freq: 'daily', interval: 10 } })],
      HORIZON,
    );
    expect(result.map((occurrence) => occurrence.startDate)).toEqual(['2026-01-01', '2026-01-11', '2026-01-21', '2026-01-31']);
  });

  it('respects EXDATE', () => {
    const result = expandIcsEvents(
      [
        event({
          uid: 'daily',
          startDate: '2026-01-01',
          rrule: { freq: 'daily', interval: 1 },
          exDates: ['2026-01-02', '2026-01-03'],
        }),
      ],
      { start: '2026-01-01', end: '2026-01-04' },
    );
    expect(result.map((occurrence) => occurrence.startDate)).toEqual(['2026-01-01', '2026-01-04']);
  });

  it('caps an unbounded RRULE (no COUNT/UNTIL) to the horizon', () => {
    const result = expandIcsEvents(
      [event({ uid: 'yearly', startDate: '2020-01-15', rrule: { freq: 'yearly', interval: 1 } })],
      HORIZON,
    );
    expect(result.map((occurrence) => occurrence.startDate)).toEqual(['2026-01-15']);
  });

  it('respects a multi-day duration across all instances', () => {
    // 2026-01-01 is a Thursday (byWeekday index 3); horizon ends before the
    // next one (2026-01-08) so only the anchor occurrence shows up here.
    const result = expandIcsEvents(
      [
        event({
          uid: 'multiday',
          startDate: '2026-01-01',
          endDate: '2026-01-03',
          rrule: { freq: 'weekly', interval: 1, byWeekday: [3] },
        }),
      ],
      { start: '2026-01-01', end: '2026-01-04' },
    );
    expect(result).toEqual([{ uid: 'multiday', title: 'Test', startDate: '2026-01-01', endDate: '2026-01-03' }]);
  });

  it('stops a COUNT-bounded series once exhausted, even inside the horizon', () => {
    const result = expandIcsEvents(
      [event({ uid: 'x', startDate: '2026-01-01', rrule: { freq: 'daily', interval: 1, count: 3 } })],
      HORIZON,
    );
    expect(result.map((occurrence) => occurrence.startDate)).toEqual(['2026-01-01', '2026-01-02', '2026-01-03']);
  });

  it('returns nothing for an empty input', () => {
    expect(expandIcsEvents([], HORIZON)).toEqual([]);
  });
});
