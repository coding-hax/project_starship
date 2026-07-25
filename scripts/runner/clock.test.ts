import { describe, expect, it } from 'vitest';
import { createClock, createFixedClock } from './clock';

describe('createFixedClock', () => {
  it('always returns the same injected instant, unlike a real clock', () => {
    const instant = new Date('2026-07-26T12:00:00Z');
    const clock = createFixedClock(instant);

    expect(clock.now()).toBe(instant);
    expect(clock.now()).toBe(instant);
  });
});

describe('createClock', () => {
  it('reflects the real time at call time', () => {
    const before = Date.now();
    const now = createClock().now().getTime();
    const after = Date.now();

    expect(now).toBeGreaterThanOrEqual(before);
    expect(now).toBeLessThanOrEqual(after);
  });
});
