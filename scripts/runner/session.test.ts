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

  // #1136 AC1: 'check' teilte sich bis hierher die Bau-Familie mit 'build' --
  // derselbe Schluessel-Fehler wie #356 (A), nur mit vertauschten Rollen.
  it('ordnet check einer eigenen Pruef-Familie zu, getrennt von build', () => {
    expect(sessionFamily('check')).toBe('check');
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

  // #1136 AC1/AC4: eigener Schluessel, damit der Pruefer die Bau-Session
  // weder liest noch ueberschreibt -- und AC4 zeigt, dass er trotzdem unter
  // dasselbe 'session-'-Praefixraster faellt, das cleanupStateDir() (siehe
  // cleanup.ts, STATE_PREFIXES) unveraendert kehrt.
  it('check-Rolle nutzt den eigenen Schluessel session-check-<nr>', () => {
    expect(sessionKey(77, 'check')).toBe('session-check-77');
  });

  it('session-check-<nr> traegt weiterhin das Praefix session- (AC4, cleanupStateDir)', () => {
    expect(sessionKey(77, 'check').startsWith('session-')).toBe(true);
  });
});
