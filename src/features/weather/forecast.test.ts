import { describe, expect, it } from 'vitest';
import type { WeatherDay, WeatherHour } from '@/local/dexie';
import {
  berlinNowMark,
  findWeatherDay,
  formatDayHeading,
  hourLabel,
  isStale,
  isWeekend,
  nextWeatherDate,
  nightTemperature,
  parseForecast,
  previousWeatherDate,
  smoothPath,
  temperatureAtHour,
  temperatureAxis,
  temperatureLinePoints,
  weekdayLabel,
  windDirectionLabel,
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
    apparent_temperature_max: [23.0, 17.8],
    wind_direction_10m_dominant: [270, 90],
  },
  hourly: {
    time: ['2026-07-23T00:00', '2026-07-23T01:00', '2026-07-24T00:00', '2026-07-24T01:00'],
    temperature_2m: [14.5, 14.1, 13.9, 13.6],
    precipitation_probability: [0, 0, 60, 80],
    precipitation: [0, 0, 1.2, 2.4],
    weather_code: [0, 1, 61, 63],
  },
};

// issue #927: a cache row written before this ticket — no apparent_temperature_max,
// wind_direction_10m_dominant or hourly.weather_code column at all.
const LEGACY_TWO_DAY_RESPONSE = {
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
        apparentTempMax: 23.0,
        windDirection: 270,
        hours: [
          {
            time: '2026-07-23T00:00',
            temperature: 14.5,
            precipitationProbability: 0,
            precipitation: 0,
            weatherCode: 0,
          },
          {
            time: '2026-07-23T01:00',
            temperature: 14.1,
            precipitationProbability: 0,
            precipitation: 0,
            weatherCode: 1,
          },
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
        apparentTempMax: 17.8,
        windDirection: 90,
        hours: [
          {
            time: '2026-07-24T00:00',
            temperature: 13.9,
            precipitationProbability: 60,
            precipitation: 1.2,
            weatherCode: 61,
          },
          {
            time: '2026-07-24T01:00',
            temperature: 13.6,
            precipitationProbability: 80,
            precipitation: 2.4,
            weatherCode: 63,
          },
        ],
      },
    ]);
  });

  it('leaves the three issue #927 fields undefined for a response without those columns (AC2)', () => {
    const days = parseForecast(LEGACY_TWO_DAY_RESPONSE);
    for (const day of days) {
      expect(day.apparentTempMax).toBeUndefined();
      expect(day.windDirection).toBeUndefined();
      for (const hour of day.hours) {
        expect(hour.weatherCode).toBeUndefined();
      }
    }
  });
});

describe('windDirectionLabel', () => {
  it('maps the eight compass points', () => {
    expect(windDirectionLabel(0)).toBe('Nord');
    expect(windDirectionLabel(45)).toBe('Nordost');
    expect(windDirectionLabel(90)).toBe('Ost');
    expect(windDirectionLabel(135)).toBe('Südost');
    expect(windDirectionLabel(180)).toBe('Süd');
    expect(windDirectionLabel(225)).toBe('Südwest');
    expect(windDirectionLabel(270)).toBe('West');
    expect(windDirectionLabel(315)).toBe('Nordwest');
    expect(windDirectionLabel(360)).toBe('Nord');
  });

  it('rounds an in-between value to the nearest octant', () => {
    expect(windDirectionLabel(20)).toBe('Nord');
    expect(windDirectionLabel(30)).toBe('Nordost');
  });

  it('normalizes negative and >360 degree values', () => {
    expect(windDirectionLabel(-45)).toBe('Nordwest');
    expect(windDirectionLabel(405)).toBe('Nordost');
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

describe('nextWeatherDate / previousWeatherDate', () => {
  const days = parseForecast(TWO_DAY_RESPONSE); // ['2026-07-23', '2026-07-24']

  it('nextWeatherDate returns the following day', () => {
    expect(nextWeatherDate(days, '2026-07-23')).toBe('2026-07-24');
  });

  it('nextWeatherDate is null at the last cached day', () => {
    expect(nextWeatherDate(days, '2026-07-24')).toBeNull();
  });

  it('previousWeatherDate returns the preceding day', () => {
    expect(previousWeatherDate(days, '2026-07-24')).toBe('2026-07-23');
  });

  it('previousWeatherDate is null at the first cached day', () => {
    expect(previousWeatherDate(days, '2026-07-23')).toBeNull();
  });

  it('both are null for a date outside the cached window', () => {
    expect(nextWeatherDate(days, '2026-08-01')).toBeNull();
    expect(previousWeatherDate(days, '2026-08-01')).toBeNull();
  });
});

describe('nightTemperature', () => {
  const hour = (time: string, temperature: number): WeatherHour => ({
    time,
    temperature,
    precipitationProbability: 0,
    precipitation: 0,
  });

  const buildDay = (
    overrides: Pick<WeatherDay, 'date' | 'sunset' | 'hours'> & Partial<Pick<WeatherDay, 'sunrise'>>,
  ): WeatherDay => ({
    weatherCode: 0,
    tempMax: 20,
    tempMin: 10,
    precipitationProbability: 0,
    sunrise: `${overrides.date}T06:00`,
    windSpeedMax: 0,
    windGustsMax: 0,
    ...overrides,
  });

  it('is the minimum across both days inside the sunset-to-sunrise window', () => {
    const day = buildDay({
      date: '2026-07-23',
      sunset: '2026-07-23T21:00',
      hours: [hour('2026-07-23T20:00', 12), hour('2026-07-23T21:00', 11), hour('2026-07-23T22:00', 9), hour('2026-07-23T23:00', 8)],
    });
    const nextDay = buildDay({
      date: '2026-07-24',
      sunset: '2026-07-24T21:00',
      hours: [
        hour('2026-07-24T00:00', 7),
        hour('2026-07-24T01:00', 6),
        hour('2026-07-24T02:00', 5),
        hour('2026-07-24T03:00', 6),
        hour('2026-07-24T04:00', 7),
        hour('2026-07-24T05:00', 8),
        hour('2026-07-24T06:00', 9),
      ],
    });
    // 20:00 (12°) liegt vor dem Fenster, bleibt außen vor.
    expect(nightTemperature(day, nextDay)).toEqual({
      value: 5,
      windowStart: '2026-07-23T21:00',
      windowEnd: '2026-07-24T06:00',
    });
  });

  it('is null without a next day (last day of the 7-day window, AC3)', () => {
    const day = buildDay({
      date: '2026-07-26',
      sunset: '2026-07-26T21:00',
      hours: [hour('2026-07-26T21:00', 11)],
    });
    expect(nightTemperature(day, null)).toBeNull();
  });

  it('spans midnight: hours from both calendar days count, the boundary hours filter correctly', () => {
    const day = buildDay({
      date: '2026-07-23',
      sunset: '2026-07-23T22:00',
      hours: [hour('2026-07-23T21:00', 10), hour('2026-07-23T22:00', 9), hour('2026-07-23T23:00', 8)],
    });
    const nextDay = buildDay({
      date: '2026-07-24',
      sunset: '2026-07-24T21:00',
      sunrise: '2026-07-24T01:00',
      hours: [hour('2026-07-24T00:00', 7), hour('2026-07-24T01:00', 6), hour('2026-07-24T02:00', 5)],
    });
    // 21:00 (10°, vor Sonnenuntergang) und 02:00 (5°, nach Sonnenaufgang) fallen raus.
    expect(nightTemperature(day, nextDay)).toEqual({
      value: 6,
      windowStart: '2026-07-23T22:00',
      windowEnd: '2026-07-24T01:00',
    });
  });

  it('finds the minimum over a sparse hourly series that only partially covers the window', () => {
    const day = buildDay({
      date: '2026-07-23',
      sunset: '2026-07-23T22:00',
      hours: [hour('2026-07-23T23:00', 12)],
    });
    const nextDay = buildDay({
      date: '2026-07-24',
      sunset: '2026-07-24T21:00',
      sunrise: '2026-07-24T05:00',
      hours: [hour('2026-07-24T00:00', 4)],
    });
    expect(nightTemperature(day, nextDay)?.value).toBe(4);
  });

  it('is null when no hour of either day falls inside the window', () => {
    const day = buildDay({
      date: '2026-07-23',
      sunset: '2026-07-23T22:00',
      hours: [hour('2026-07-23T10:00', 10)],
    });
    const nextDay = buildDay({
      date: '2026-07-24',
      sunset: '2026-07-24T21:00',
      sunrise: '2026-07-24T05:00',
      hours: [hour('2026-07-24T10:00', 10)],
    });
    expect(nightTemperature(day, nextDay)).toBeNull();
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
  it('scales two points one slot apart, height scaled to the full box', () => {
    const hours = [
      { time: '2026-07-23T00:00', temperature: 10, precipitationProbability: 0, precipitation: 0 },
      { time: '2026-07-23T01:00', temperature: 20, precipitationProbability: 0, precipitation: 0 },
    ];
    expect(temperatureLinePoints(hours, 100, 50)).toBe('0.0,50.0 50.0,0.0');
  });

  it('is empty for no hours', () => {
    expect(temperatureLinePoints([], 100, 50)).toBe('');
  });

  it('flattens to the bottom edge when every hour has the same temperature (range treated as 1, not 0)', () => {
    const hours = [
      { time: '2026-07-23T00:00', temperature: 15, precipitationProbability: 0, precipitation: 0 },
      { time: '2026-07-23T01:00', temperature: 15, precipitationProbability: 0, precipitation: 0 },
    ];
    expect(temperatureLinePoints(hours, 100, 50)).toBe('0.0,50.0 50.0,50.0');
  });

  it('scales into a given domain instead of the raw min/max', () => {
    const hours = [
      { time: '2026-07-23T00:00', temperature: 10, precipitationProbability: 0, precipitation: 0 },
      { time: '2026-07-23T01:00', temperature: 20, precipitationProbability: 0, precipitation: 0 },
    ];
    // Domain twice the data's span: the curve uses the middle half of the box.
    expect(temperatureLinePoints(hours, 100, 40, { min: 0, max: 40 })).toBe('0.0,30.0 50.0,20.0');
  });
});

describe('smoothPath', () => {
  it('starts and ends exactly on the two data points', () => {
    const hours = [
      { time: '2026-07-23T00:00', temperature: 10, precipitationProbability: 0, precipitation: 0 },
      { time: '2026-07-23T01:00', temperature: 20, precipitationProbability: 0, precipitation: 0 },
    ];
    const { line } = smoothPath(hours, 100, 50);
    expect(line.startsWith('M0.0,50.0')).toBe(true);
    expect(line.endsWith('50.0,0.0')).toBe(true);
  });

  it('flattens to a single y across a constant series', () => {
    const hours = [
      { time: '2026-07-23T00:00', temperature: 15, precipitationProbability: 0, precipitation: 0 },
      { time: '2026-07-23T01:00', temperature: 15, precipitationProbability: 0, precipitation: 0 },
    ];
    const { line } = smoothPath(hours, 100, 50);
    expect(line.endsWith('50.0,50.0')).toBe(true);
  });

  it('has one C segment fewer than the number of points, one per 24-hour day', () => {
    const hours = Array.from({ length: 24 }, (_, i) => ({
      time: `2026-07-23T${String(i).padStart(2, '0')}:00`,
      temperature: 14 + (10 * i) / 23,
      precipitationProbability: 0,
      precipitation: 0,
    }));
    const { line } = smoothPath(hours, 300, 80);
    expect(line.startsWith('M')).toBe(true);
    expect(line.match(/C/g)).toHaveLength(23);
  });

  it('closes the area from the curve down to the baseline and back', () => {
    const hours = [
      { time: '2026-07-23T00:00', temperature: 10, precipitationProbability: 0, precipitation: 0 },
      { time: '2026-07-23T01:00', temperature: 20, precipitationProbability: 0, precipitation: 0 },
    ];
    const { line, area } = smoothPath(hours, 100, 50);
    expect(area.startsWith(line)).toBe(true);
    expect(area.match(/L/g)?.length).toBeGreaterThanOrEqual(1);
    expect(area.endsWith('Z')).toBe(true);
  });

  it('is empty for no hours', () => {
    expect(smoothPath([], 100, 50)).toEqual({ line: '', area: '' });
  });

  it('is a bare move for a single hour, with no area', () => {
    const hours = [
      { time: '2026-07-23T00:00', temperature: 12, precipitationProbability: 0, precipitation: 0 },
    ];
    expect(smoothPath(hours, 100, 50)).toEqual({ line: 'M0.0,50.0', area: '' });
  });
});

describe('berlinNowMark', () => {
  it('reads the Berlin-local hour, offset from UTC by the summer +2h', () => {
    expect(berlinNowMark(new Date('2026-07-20T09:00:00.000Z'))).toEqual({
      dateKey: '2026-07-20',
      hourOfDay: 11,
    });
  });

  it('rolls the date key over at Berlin midnight, not UTC midnight', () => {
    expect(berlinNowMark(new Date('2026-07-20T23:00:00.000Z'))).toEqual({
      dateKey: '2026-07-21',
      hourOfDay: 1,
    });
  });

  it('carries the minute as a fraction of the hour', () => {
    expect(berlinNowMark(new Date('2026-07-20T09:30:00.000Z')).hourOfDay).toBe(11.5);
  });
});

describe('temperatureAtHour', () => {
  const hours = [
    { time: '2026-07-23T00:00', temperature: 10, precipitationProbability: 0, precipitation: 0 },
    { time: '2026-07-23T01:00', temperature: 20, precipitationProbability: 0, precipitation: 0 },
    { time: '2026-07-23T02:00', temperature: 24, precipitationProbability: 0, precipitation: 0 },
  ];

  it('lands exactly on the hour for a whole-number hourOfDay', () => {
    expect(temperatureAtHour(hours, 1)).toBe(20);
  });

  it('interpolates linearly between the two enclosing hours', () => {
    expect(temperatureAtHour(hours, 0.5)).toBe(15);
  });

  it('clamps below the first hour', () => {
    expect(temperatureAtHour(hours, -3)).toBe(10);
  });

  it('clamps past the last hour', () => {
    expect(temperatureAtHour(hours, 30)).toBe(24);
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
