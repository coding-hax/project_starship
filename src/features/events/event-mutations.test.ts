import { describe, expect, it } from 'vitest';
import { remainingRecurrence, truncateRecurrence } from './event-mutations';
import type { Recurrence } from './recurrence';

describe('truncateRecurrence — daily, no existing bound', () => {
  const rule: Recurrence = { freq: 'daily', interval: 1 };

  it('ends the day before the split point', () => {
    expect(truncateRecurrence(rule, '2026-07-01', '2026-07-10')).toEqual({
      freq: 'daily',
      interval: 1,
      until: '2026-07-09',
    });
  });

  it('splitting at the anchor itself leaves nothing before it', () => {
    expect(truncateRecurrence(rule, '2026-07-01', '2026-07-01')).toEqual({
      freq: 'daily',
      interval: 1,
      until: '2026-06-30',
    });
  });
});

describe('truncateRecurrence — existing `until`', () => {
  const rule: Recurrence = { freq: 'daily', interval: 1, until: '2026-07-20' };

  it('tightens `until` when the split point is earlier', () => {
    expect(truncateRecurrence(rule, '2026-07-01', '2026-07-10').until).toBe('2026-07-09');
  });

  it('keeps the original `until` when it is already earlier than the split point', () => {
    expect(truncateRecurrence(rule, '2026-07-01', '2026-08-01').until).toBe('2026-07-20');
  });
});

describe('truncateRecurrence — existing `count`, weekly', () => {
  const rule: Recurrence = { freq: 'weekly', interval: 1, byWeekday: [0], count: 10 };

  it('counts only the occurrences strictly before the split point', () => {
    // Monday anchor, weekly — the 3rd occurrence is 2026-07-27 + 14 days.
    const result = truncateRecurrence(rule, '2026-07-13', '2026-07-27');
    expect(result.count).toBe(2);
  });

  it('never exceeds the original count', () => {
    const result = truncateRecurrence(rule, '2026-07-13', '2030-01-01');
    expect(result.count).toBe(10);
  });
});

describe('remainingRecurrence — daily, no existing bound', () => {
  const rule: Recurrence = { freq: 'daily', interval: 1 };

  it('re-anchors at the split point with no bound copied', () => {
    expect(remainingRecurrence(rule, '2026-07-01', '2026-07-10')).toEqual({
      freq: 'daily',
      interval: 1,
    });
  });
});

describe('remainingRecurrence — existing `until`', () => {
  const rule: Recurrence = { freq: 'daily', interval: 1, until: '2026-07-20' };

  it('carries the absolute `until` over unchanged', () => {
    expect(remainingRecurrence(rule, '2026-07-01', '2026-07-10').until).toBe('2026-07-20');
  });
});

describe('remainingRecurrence — existing `count`, weekly', () => {
  const rule: Recurrence = { freq: 'weekly', interval: 1, byWeekday: [0], count: 10 };

  it('subtracts the occurrences that already happened before the split point', () => {
    const result = remainingRecurrence(rule, '2026-07-13', '2026-07-27');
    expect(result.count).toBe(8);
  });

  it('splitting at the anchor itself keeps the full count', () => {
    const result = remainingRecurrence(rule, '2026-07-13', '2026-07-13');
    expect(result.count).toBe(10);
  });

  it('preserves `byWeekday`', () => {
    expect(remainingRecurrence(rule, '2026-07-13', '2026-07-27').byWeekday).toEqual([0]);
  });
});

describe('truncateRecurrence + remainingRecurrence — monthly interval', () => {
  const rule: Recurrence = { freq: 'monthly', interval: 2 };

  it('head and tail together cover every original occurrence exactly once', () => {
    // Anchor 2026-01-15, interval 2 -> occurrences: Jan, Mar, May, Jul, Sep ...
    const truncated = truncateRecurrence(rule, '2026-01-15', '2026-07-15');
    const remaining = remainingRecurrence(rule, '2026-01-15', '2026-07-15');
    expect(truncated.until).toBe('2026-07-14');
    expect(remaining.until).toBeUndefined();
  });
});
