import { describe, expect, it } from 'vitest';
import {
  findWeatherDay,
  formatDayHeading,
  hourLabel,
  isStale,
  isWeekend,
  parseForecast,
  temperatureAxis,
  temperatureLinePoints,
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

const TWO_DAY_RESPONSE = {
  daily: {
    time: ['2026-07-23', '2026-07-24'],
    weather_code: [0, 61],
    temperature_2m_max: [24.1, 19.5],
    temperature_2m_min: [14.2, 13.8],
    precipitation_probability_max: [0, 80],
    sunrise: ['2026-07-23T05:53', '2026-07-24T05:54'],
    sunset: ['2026-07-23T21:12', '2026-07-24T21:11'],
    wind_speed_10m_max: [12.4, 18.9],
    wind_gusts_10m_max: [24.1, 33.6],
  },
  hourly: {
    time: ['2026-07-23T00:00', '2026-07-23T01:00', '2026-07-24T00:00', '2026-07-24T01:00'],
    temperature_2m: [14.5, 14.1, 13.9, 13.6],
    precipitation_probability: [0, 0, 60, 80],
    precipitation: [0, 0, 1.2, 2.4],
  },
};

describe('parseForecast', () => {
  it('turns the column-oriented Open-Meteo response into one row per day, hours nested by date', () => {
    expect(parseForecast(TWO_DAY_RESPONSE)).toEqual([
      {
        date: '2026-07-23',
        weatherCode: 0,
        tempMax: 24.1,
        tempMin: 14.2,
        precipitationProbability: 0,
        sunrise: '2026-07-23T05:53',
        sunset: '2026-07-23T21:12',
        windSpeedMax: 12.4,
        windGustsMax: 24.1,
        hours: [
          { time: '2026-07-23T00:00', temperature: 14.5, precipitationProbability: 0, precipitation: 0 },
          { time: '2026-07-23T01:00', temperature: 14.1, precipitationProbability: 0, precipitation: 0 },
        ],
      },
      {
        date: '2026-07-24',
        weatherCode: 61,
        tempMax: 19.5,
        tempMin: 13.8,
        precipitationProbability: 80,
        sunrise: '2026-07-24T05:54',
        sunset: '2026-07-24T21:11',
        windSpeedMax: 18.9,
        windGustsMax: 33.6,
        hours: [
          { time: '2026-07-24T00:00', temperature: 13.9, precipitationProbability: 60, precipitation: 1.2 },
          { time: '2026-07-24T01:00', temperature: 13.6, precipitationProbability: 80, precipitation: 2.4 },
        ],
      },
    ]);
  });
});

describe('findWeatherDay', () => {
  const days = parseForecast(TWO_DAY_RESPONSE);

  it('finds the day matching the date key', () => {
    expect(findWeatherDay(days, '2026-07-24')?.tempMax).toBe(19.5);
  });

  it('is undefined for a date outside the window', () => {
    expect(findWeatherDay(days, '2026-08-01')).toBeUndefined();
  });
});

describe('hourLabel', () => {
  it('reads HH:MM straight off a local ISO instant, no timezone conversion', () => {
    expect(hourLabel('2026-07-23T05:53')).toBe('05:53');
    expect(hourLabel('2026-07-23T21:12')).toBe('21:12');
  });
});

describe('formatDayHeading', () => {
  it('formats weekday, day and month, local calendar day', () => {
    expect(formatDayHeading('2026-07-20')).toBe('Montag, 20. Juli');
  });
});

describe('temperatureLinePoints', () => {
  it('scales two points across the full width and height', () => {
    const hours = [
      { time: '2026-07-23T00:00', temperature: 10, precipitationProbability: 0, precipitation: 0 },
      { time: '2026-07-23T01:00', temperature: 20, precipitationProbability: 0, precipitation: 0 },
    ];
    expect(temperatureLinePoints(hours, 100, 50)).toBe('0.0,50.0 100.0,0.0');
  });

  it('is empty for no hours', () => {
    expect(temperatureLinePoints([], 100, 50)).toBe('');
  });

  it('flattens to the bottom edge when every hour has the same temperature (range treated as 1, not 0)', () => {
    const hours = [
      { time: '2026-07-23T00:00', temperature: 15, precipitationProbability: 0, precipitation: 0 },
      { time: '2026-07-23T01:00', temperature: 15, precipitationProbability: 0, precipitation: 0 },
    ];
    expect(temperatureLinePoints(hours, 100, 50)).toBe('0.0,50.0 100.0,50.0');
  });

  it('scales into a given domain instead of the raw min/max', () => {
    const hours = [
      { time: '2026-07-23T00:00', temperature: 10, precipitationProbability: 0, precipitation: 0 },
      { time: '2026-07-23T01:00', temperature: 20, precipitationProbability: 0, precipitation: 0 },
    ];
    // Domain twice the data's span: the curve uses the middle half of the box.
    expect(temperatureLinePoints(hours, 100, 40, { min: 0, max: 40 })).toBe('0.0,30.0 100.0,20.0');
  });
});

describe('temperatureAxis', () => {
  const hoursAt = (...temps: number[]) =>
    temps.map((temperature, i) => ({
      time: `2026-07-23T${String(i).padStart(2, '0')}:00`,
      temperature,
      precipitationProbability: 0,
      precipitation: 0,
    }));

  it('snaps the range outwards to whole degrees so every tick is an integer', () => {
    expect(temperatureAxis(hoursAt(4.2, 14.7))).toEqual({ min: 4, max: 15, ticks: [4, 10, 15] });
  });

  it('keeps a degree of range when every hour has the same temperature', () => {
    expect(temperatureAxis(hoursAt(15, 15))).toEqual({ min: 15, max: 16, ticks: [15, 16] });
  });

  it('handles a range below zero', () => {
    expect(temperatureAxis(hoursAt(-6.5, -1.2))).toEqual({ min: -7, max: -1, ticks: [-7, -4, -1] });
  });

  it('has no ticks without hours', () => {
    expect(temperatureAxis([]).ticks).toEqual([]);
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
