import { describe, expect, it } from 'vitest';
import { weatherCategory } from './wmo-icon';

describe('weatherCategory', () => {
  it('maps clear sky', () => {
    expect(weatherCategory(0)).toBe('clear');
  });

  it('maps mainly clear / partly cloudy', () => {
    expect(weatherCategory(1)).toBe('partly-cloudy');
    expect(weatherCategory(2)).toBe('partly-cloudy');
  });

  it('maps overcast', () => {
    expect(weatherCategory(3)).toBe('cloudy');
  });

  it('maps fog', () => {
    expect(weatherCategory(45)).toBe('fog');
    expect(weatherCategory(48)).toBe('fog');
  });

  it('maps drizzle, rain and rain showers', () => {
    for (const code of [51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 80, 81, 82]) {
      expect(weatherCategory(code)).toBe('rain');
    }
  });

  it('maps snow fall and snow showers', () => {
    for (const code of [71, 73, 75, 77, 85, 86]) {
      expect(weatherCategory(code)).toBe('snow');
    }
  });

  it('maps thunderstorm, with and without hail', () => {
    expect(weatherCategory(95)).toBe('thunderstorm');
    expect(weatherCategory(96)).toBe('thunderstorm');
    expect(weatherCategory(99)).toBe('thunderstorm');
  });

  it('falls back to cloudy for an unknown code', () => {
    expect(weatherCategory(1234)).toBe('cloudy');
  });
});
