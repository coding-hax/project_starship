import { describe, expect, it } from 'vitest';
import {
  formatStaleSince,
  isStale,
  isStaleWarning,
  isWeekend,
  parseForecast,
  weekdayLabel,
} from './forecast';

describe('isStale', () => {
  const fetchedAt = '2026-07-23T09:00:00.000Z';

  it('is not stale right after fetching', () => {
    expect(isStale(fetchedAt, new Date(fetchedAt))).toBe(false);
  });

  it('is not stale just under 3 hours later', () => {
    expect(isStale(fetchedAt, new Date('2026-07-23T11:59:59.999Z'))).toBe(false);
  });

  it('is stale at exactly 3 hours', () => {
    expect(isStale(fetchedAt, new Date('2026-07-23T12:00:00.000Z'))).toBe(true);
  });

  it('is stale well past 3 hours', () => {
    expect(isStale(fetchedAt, new Date('2026-07-24T09:00:00.000Z'))).toBe(true);
  });
});

describe('parseForecast', () => {
  it('turns the column-oriented Open-Meteo response into one row per day', () => {
    expect(
      parseForecast({
        daily: {
          time: ['2026-07-23', '2026-07-24'],
          weather_code: [0, 61],
          temperature_2m_max: [24.1, 19.5],
          temperature_2m_min: [14.2, 13.8],
          precipitation_probability_max: [0, 80],
        },
      }),
    ).toEqual([
      { date: '2026-07-23', weatherCode: 0, tempMax: 24.1, tempMin: 14.2, precipitationProbability: 0 },
      { date: '2026-07-24', weatherCode: 61, tempMax: 19.5, tempMin: 13.8, precipitationProbability: 80 },
    ]);
  });
});

describe('weekdayLabel', () => {
  it('reads the local weekday, not UTC, off a date key', () => {
    // A Wednesday, per docs/DESIGN_SYSTEM.md examples elsewhere (2026-07-15).
    expect(weekdayLabel('2026-07-15')).toBe('Mi');
  });

  it('covers the full week', () => {
    expect(weekdayLabel('2026-07-13')).toBe('Mo');
    expect(weekdayLabel('2026-07-14')).toBe('Di');
    expect(weekdayLabel('2026-07-16')).toBe('Do');
    expect(weekdayLabel('2026-07-17')).toBe('Fr');
    expect(weekdayLabel('2026-07-18')).toBe('Sa');
    expect(weekdayLabel('2026-07-19')).toBe('So');
  });
});

describe('isWeekend', () => {
  it('is false for weekdays', () => {
    expect(isWeekend('2026-07-13')).toBe(false); // Mo
    expect(isWeekend('2026-07-17')).toBe(false); // Fr
  });

  it('is true for Saturday and Sunday', () => {
    expect(isWeekend('2026-07-18')).toBe(true); // Sa
    expect(isWeekend('2026-07-19')).toBe(true); // So
  });
});

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
