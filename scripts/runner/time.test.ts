import { describe, expect, it } from 'vitest';
import { createFixedClock } from './clock';
import { dPlus, fmtHm, resetEpoch } from './time';

describe('fmtHm', () => {
  it('formats an epoch like `date -r <epoch> "+%a %H:%M"`', () => {
    const date = new Date(2026, 6, 26, 14, 51, 0);
    const epoch = Math.floor(date.getTime() / 1000);
    const weekday = date.toLocaleDateString('en-US', { weekday: 'short' });

    expect(fmtHm(epoch)).toBe(`${weekday} 14:51`);
  });

  it('returns null for non-numeric input, matching a failed `date` call', () => {
    expect(fmtHm(Number.NaN)).toBeNull();
  });
});

describe('dPlus', () => {
  it('adds days to the clock-provided "today" and formats with the given pattern', () => {
    const clock = createFixedClock(new Date(2026, 6, 20, 9, 0, 0));
    expect(dPlus(6, '%Y-%m-%d', clock)).toBe('2026-07-26');
  });

  it('returns null for non-numeric day counts', () => {
    const clock = createFixedClock(new Date());
    expect(dPlus(Number.NaN, '%Y-%m-%d', clock)).toBeNull();
  });
});

describe('resetEpoch', () => {
  it('returns null when the text has no "resets" at all', () => {
    const clock = createFixedClock(new Date());
    expect(resetEpoch('irgendeine andere Meldung', clock)).toBeNull();
  });

  it('parses a session-limit message (time only, <=24h away, same day)', () => {
    const clock = createFixedClock(new Date(2026, 6, 26, 14, 0, 0));
    const epoch = resetEpoch('… session limit · resets 2:50pm (Europe/Berlin)', clock);

    expect(epoch).not.toBeNull();
    const parsed = new Date(epoch! * 1000);
    expect([parsed.getFullYear(), parsed.getMonth(), parsed.getDate()]).toEqual([2026, 6, 26]);
    expect(parsed.getHours()).toBe(14);
    expect(parsed.getMinutes()).toBe(51); // +60s Puffer rollt :50 auf :51
  });

  it('rolls a just-past-midnight time onto tomorrow when that keeps it within the ~6h guard', () => {
    // 23:00 heute, Ziel "kurz nach Mitternacht" -> das ist in ~1h, nicht in ~23h.
    const clock = createFixedClock(new Date(2026, 6, 26, 23, 0, 0));
    const epoch = resetEpoch('… session limit · resets 12:01am (Europe/Berlin)', clock);

    expect(epoch).not.toBeNull();
    const parsed = new Date(epoch! * 1000);
    expect(parsed.getDate()).toBe(27);
    expect(parsed.getHours()).toBe(0);
    expect(parsed.getMinutes()).toBe(2);
  });

  it('discards a session-limit parse that would be more than ~6h out (mis-parse guard)', () => {
    const clock = createFixedClock(new Date(2026, 6, 26, 0, 0, 0));
    expect(resetEpoch('… session limit · resets 11am (Europe/Berlin)', clock)).toBeNull();
  });

  it('parses a weekly-limit message with a month+day but no year', () => {
    const clock = createFixedClock(new Date(2026, 6, 12, 0, 0, 0)); // 12. Juli 2026, < 7 Tage vor dem Ziel
    const epoch = resetEpoch('… weekly limit  · resets Jul 17, 5:09pm (Europe/Berlin)', clock);

    expect(epoch).not.toBeNull();
    const parsed = new Date(epoch! * 1000);
    expect([parsed.getFullYear(), parsed.getMonth(), parsed.getDate()]).toEqual([2026, 6, 17]);
    expect(parsed.getHours()).toBe(17);
    expect(parsed.getMinutes()).toBe(10); // 5:09pm + 60s Puffer
  });

  it('parses a weekly-limit message with an explicit year', () => {
    const clock = createFixedClock(new Date(2027, 0, 25, 0, 0, 0)); // 25. Januar 2027
    const epoch = resetEpoch('… weekly limit  · resets Jan 30, 2027, 4:09pm (Europe/Berlin)', clock);

    expect(epoch).not.toBeNull();
    const parsed = new Date(epoch! * 1000);
    expect([parsed.getFullYear(), parsed.getMonth(), parsed.getDate()]).toEqual([2027, 0, 30]);
    expect(parsed.getHours()).toBe(16);
    expect(parsed.getMinutes()).toBe(10);
  });

  it('caps an absurdly far-away weekly reset at 7 days out', () => {
    const clock = createFixedClock(new Date(2026, 5, 1, 0, 0, 0)); // 1. Juni 2026
    const epoch = resetEpoch('… weekly limit  · resets Jul 17, 5:09pm (Europe/Berlin)', clock);

    const now = Math.floor(clock.now().getTime() / 1000);
    expect(epoch).toBe(now + 604800);
  });

  it('rejects a weekly-limit date that already lies in the past', () => {
    const clock = createFixedClock(new Date(2026, 6, 1, 0, 0, 0));
    expect(resetEpoch('… weekly limit  · resets Jul 1, 2020, 5:09pm (Europe/Berlin)', clock)).toBeNull();
  });
});
