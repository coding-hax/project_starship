import { describe, expect, it } from 'vitest';
import { berlinInstant } from '@/push/schedule';
import { greetingFor } from './greeting';

// Summer date (CEST, UTC+2) — berlinInstant builds the UTC instant whose Berlin
// wall-clock reading is the given time, so these fixtures are host-TZ-independent
// (CI runs UTC, a dev machine might not — see greeting.ts).
function at(hours: number, minutes: number): Date {
  return berlinInstant('2026-07-15', hours * 60 + minutes);
}

describe('greetingFor', () => {
  it('says Gute Nacht right before the morning boundary (04:59)', () => {
    expect(greetingFor(at(4, 59))).toBe('Gute Nacht');
  });

  it('switches to Guten Morgen at the boundary (05:00)', () => {
    expect(greetingFor(at(5, 0))).toBe('Guten Morgen');
  });

  it('stays Guten Morgen right before the midday boundary (10:59)', () => {
    expect(greetingFor(at(10, 59))).toBe('Guten Morgen');
  });

  it('switches to Guten Mittag at the boundary (11:00)', () => {
    expect(greetingFor(at(11, 0))).toBe('Guten Mittag');
  });

  it('stays Guten Mittag right before the evening boundary (16:59)', () => {
    expect(greetingFor(at(16, 59))).toBe('Guten Mittag');
  });

  it('switches to Guten Abend at the boundary (17:00)', () => {
    expect(greetingFor(at(17, 0))).toBe('Guten Abend');
  });

  it('stays Guten Abend right before the night boundary (21:59)', () => {
    expect(greetingFor(at(21, 59))).toBe('Guten Abend');
  });

  it('switches to Gute Nacht at the boundary (22:00)', () => {
    expect(greetingFor(at(22, 0))).toBe('Gute Nacht');
  });

  it('stays Gute Nacht across midnight', () => {
    expect(greetingFor(at(0, 0))).toBe('Gute Nacht');
  });
});
