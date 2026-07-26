import { describe, expect, it } from 'vitest';
import {
  formatDistance,
  formatDuration,
  formatElevation,
  formatHr,
  formatPace,
  formatPause,
} from './format';

describe('formatDistance', () => {
  it('renders one decimal km', () => {
    expect(formatDistance(5432)).toBe('5.4 km');
  });

  it('is an en dash for null', () => {
    expect(formatDistance(null)).toBe('–');
  });
});

describe('formatDuration', () => {
  it('renders h:mm:ss above an hour', () => {
    expect(formatDuration(3852)).toBe('1:04:12');
  });

  it('renders m:ss below an hour without a leading zero', () => {
    expect(formatDuration(252)).toBe('4:12');
  });

  it('is an en dash for null', () => {
    expect(formatDuration(null)).toBe('–');
  });
});

describe('formatPause', () => {
  it('renders zero pause as 0:00, not a dash', () => {
    expect(formatPause(0)).toBe('0:00');
  });

  it('is an en dash for null', () => {
    expect(formatPause(null)).toBe('–');
  });
});

describe('formatPace', () => {
  it('converts m/s to min/km', () => {
    expect(formatPace(4)).toBe('4:10 min/km');
  });

  it('is an en dash for null', () => {
    expect(formatPace(null)).toBe('–');
  });

  it('is an en dash for a stopped/near-zero speed', () => {
    expect(formatPace(0)).toBe('–');
  });
});

describe('formatHr', () => {
  it('renders bpm', () => {
    expect(formatHr(150)).toBe('150 bpm');
  });

  it('is an en dash for null', () => {
    expect(formatHr(null)).toBe('–');
  });
});

describe('formatElevation', () => {
  it('renders meters', () => {
    expect(formatElevation(340)).toBe('340 m');
  });

  it('is an en dash for null', () => {
    expect(formatElevation(null)).toBe('–');
  });
});
