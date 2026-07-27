import { describe, expect, it } from 'vitest';
import { formatStaleSince, isStaleWarning } from './stale';

describe('isStaleWarning', () => {
  const fetchedAt = '2026-07-23T09:00:00.000Z';

  it('is not a warning just under 8 hours later', () => {
    expect(isStaleWarning(fetchedAt, new Date('2026-07-23T16:59:59.999Z'))).toBe(false);
  });

  it('is a warning at exactly 8 hours', () => {
    expect(isStaleWarning(fetchedAt, new Date('2026-07-23T17:00:00.000Z'))).toBe(true);
  });

  it('is a warning well past 8 hours', () => {
    expect(isStaleWarning(fetchedAt, new Date('2026-07-24T09:00:00.000Z'))).toBe(true);
  });
});

describe('formatStaleSince', () => {
  it('formats as 24-hour HH:MM, local time', () => {
    const date = new Date(2026, 6, 23, 14, 32);
    expect(formatStaleSince(date.toISOString())).toBe('14:32');
  });

  it('pads single-digit hours and minutes', () => {
    const date = new Date(2026, 6, 23, 3, 5);
    expect(formatStaleSince(date.toISOString())).toBe('03:05');
  });
});
