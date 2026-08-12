import { describe, expect, it } from 'vitest';
import { isWindy } from './forecast';

describe('isWindy (issue #695)', () => {
  it('is windy right at the gust threshold, 50 km/h (>= applies)', () => {
    expect(isWindy({ windGustsMax: 50, windSpeedMax: 10 })).toBe(true);
  });

  it('is not windy just under both thresholds', () => {
    expect(isWindy({ windGustsMax: 49, windSpeedMax: 29 })).toBe(false);
  });

  it('is windy on the average-wind threshold alone, even with mild gusts', () => {
    expect(isWindy({ windGustsMax: 20, windSpeedMax: 30 })).toBe(true);
  });

  it('is not windy at zero wind', () => {
    expect(isWindy({ windGustsMax: 0, windSpeedMax: 0 })).toBe(false);
  });
});
