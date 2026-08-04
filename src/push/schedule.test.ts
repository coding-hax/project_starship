import { describe, expect, it } from 'vitest';
import { berlinInstant, berlinNow, dueSlots } from './schedule';

describe('berlinNow', () => {
  it('reports 07:00 Berlin time on a summer date (CEST, UTC+2)', () => {
    expect(berlinNow(new Date(Date.UTC(2026, 6, 15, 5, 0)))).toEqual({
      dateKey: '2026-07-15',
      minutesOfDay: 7 * 60,
    });
  });

  it('reports 07:00 Berlin time on a winter date (CET, UTC+1)', () => {
    expect(berlinNow(new Date(Date.UTC(2026, 0, 15, 6, 0)))).toEqual({
      dateKey: '2026-01-15',
      minutesOfDay: 7 * 60,
    });
  });

  it('07:00 Berlin stays 07:00 across the spring changeover (2026-03-29, CET -> CEST)', () => {
    // 05:00 UTC is already CEST on this date, so this is 07:00 local, not 08:00.
    expect(berlinNow(new Date(Date.UTC(2026, 2, 29, 5, 0)))).toEqual({
      dateKey: '2026-03-29',
      minutesOfDay: 7 * 60,
    });
  });

  it('07:00 Berlin stays 07:00 across the autumn changeover (2026-10-25, CEST -> CET)', () => {
    // 06:00 UTC is already CET on this date, so this is 07:00 local, not 06:00.
    expect(berlinNow(new Date(Date.UTC(2026, 9, 25, 6, 0)))).toEqual({
      dateKey: '2026-10-25',
      minutesOfDay: 7 * 60,
    });
  });
});

describe('berlinInstant', () => {
  it('is the inverse of berlinNow on a summer date (CEST, UTC+2)', () => {
    const instant = berlinInstant('2026-07-15', 9 * 60);
    expect(berlinNow(instant)).toEqual({ dateKey: '2026-07-15', minutesOfDay: 9 * 60 });
  });

  it('is the inverse of berlinNow on a winter date (CET, UTC+1)', () => {
    const instant = berlinInstant('2026-01-15', 9 * 60);
    expect(berlinNow(instant)).toEqual({ dateKey: '2026-01-15', minutesOfDay: 9 * 60 });
  });

  it('round-trips 09:00 Berlin across the spring changeover (2026-03-29, CET -> CEST)', () => {
    const instant = berlinInstant('2026-03-29', 9 * 60);
    expect(berlinNow(instant)).toEqual({ dateKey: '2026-03-29', minutesOfDay: 9 * 60 });
  });

  it('round-trips 09:00 Berlin across the autumn changeover (2026-10-25, CEST -> CET)', () => {
    const instant = berlinInstant('2026-10-25', 9 * 60);
    expect(berlinNow(instant)).toEqual({ dateKey: '2026-10-25', minutesOfDay: 9 * 60 });
  });
});

describe('dueSlots', () => {
  const kinds = [{ kind: 'tasks-due', times: ['07:00'] }];

  it('is due once the slot time has arrived', () => {
    // 07:00 Berlin = 05:00 UTC in July (CEST).
    expect(dueSlots(new Date(Date.UTC(2026, 6, 15, 5, 0)), kinds)).toEqual([
      { kind: 'tasks-due', slot: '07:00', dateKey: '2026-07-15' },
    ]);
  });

  it('is not due before the slot time', () => {
    // 06:30 Berlin = 04:30 UTC in July.
    expect(dueSlots(new Date(Date.UTC(2026, 6, 15, 4, 30)), kinds)).toEqual([]);
  });

  it('catches up a delayed run (07:35) that is still after the slot', () => {
    expect(dueSlots(new Date(Date.UTC(2026, 6, 15, 5, 35)), kinds)).toEqual([
      { kind: 'tasks-due', slot: '07:00', dateKey: '2026-07-15' },
    ]);
  });

  it('does not carry a slot over past midnight', () => {
    // 00:30 Berlin the next day: minutesOfDay resets, so 07:00 is not due yet again.
    expect(dueSlots(new Date(Date.UTC(2026, 6, 15, 22, 30)), kinds)).toEqual([]);
  });

  it('treats each time of a multi-time kind as its own separately due slot', () => {
    const multi = [{ kind: 'habits-open', times: ['07:00', '20:00'] }];
    // 21:00 Berlin = 19:00 UTC: both slots have passed.
    expect(dueSlots(new Date(Date.UTC(2026, 6, 15, 19, 0)), multi)).toEqual([
      { kind: 'habits-open', slot: '07:00', dateKey: '2026-07-15' },
      { kind: 'habits-open', slot: '20:00', dateKey: '2026-07-15' },
    ]);
  });

  it('does not let a later slot swallow an earlier one for the same kind', () => {
    const multi = [{ kind: 'habits-open', times: ['07:00', '20:00'] }];
    // 08:00 Berlin: only the first slot has passed.
    expect(dueSlots(new Date(Date.UTC(2026, 6, 15, 6, 0)), multi)).toEqual([
      { kind: 'habits-open', slot: '07:00', dateKey: '2026-07-15' },
    ]);
  });
});
