import { describe, expect, it } from 'vitest';
import { sessionFamily, sessionKey } from './session';

describe('sessionFamily', () => {
  it('ordnet plan/research der Denk-Familie zu', () => {
    expect(sessionFamily('plan')).toBe('think');
    expect(sessionFamily('research')).toBe('think');
  });

  it('ordnet build der Bau-Familie zu', () => {
    expect(sessionFamily('build')).toBe('build');
  });
});

describe('sessionKey', () => {
  it('build-Rolle nutzt weiterhin session-<nr> (rueckwaertskompatibel)', () => {
    expect(sessionKey(77, 'build')).toBe('session-77');
  });

  it('plan-Rolle nutzt session-think-<nr>', () => {
    expect(sessionKey(77, 'plan')).toBe('session-think-77');
  });

  it('research-Rolle nutzt session-think-<nr>', () => {
    expect(sessionKey(47, 'research')).toBe('session-think-47');
  });
});
