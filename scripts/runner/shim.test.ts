import { describe, expect, it } from 'vitest';
import { shimDriftReason } from './shim.js';
import type { GitAdapter } from './git.js';

const SHIM = '/home/x/.local/bin/starship-runner';

function gitWith(canonical: string | Error): GitAdapter {
  return {
    run: () => {
      if (canonical instanceof Error) throw canonical;
      return canonical;
    },
  };
}

describe('shimDriftReason', () => {
  it('meldet keinen Drift, wenn installiert und kanonisch gleich sind', () => {
    const git = gitWith('#!/usr/bin/env bash\necho hi');
    const read = () => '#!/usr/bin/env bash\necho hi';
    expect(shimDriftReason(SHIM, 'origin/main', git, read)).toBe('');
  });

  it('meldet Drift, wenn die installierte Datei abweicht', () => {
    const git = gitWith('#!/usr/bin/env bash\necho hi');
    const read = () => '#!/usr/bin/env bash\necho hi\n# von Hand geaendert';
    const reason = shimDriftReason(SHIM, 'origin/main', git, read);
    expect(reason).not.toBe('');
    expect(reason).toContain(SHIM);
    expect(reason).toContain('scripts/starship-runner');
  });

  // Der git-Adapter schneidet abschliessende Newlines ab. Ohne dieselbe
  // Normalisierung auf der Dateiseite meldete jede Datei Drift, nur weil sie
  // mit einem Zeilenumbruch endet -- ein Daueralarm, den niemand mehr liest.
  it('ignoriert einen blossen Zeilenende-Unterschied', () => {
    const git = gitWith('#!/usr/bin/env bash\necho hi');
    const read = () => '#!/usr/bin/env bash\necho hi\n';
    expect(shimDriftReason(SHIM, 'origin/main', git, read)).toBe('');
  });

  it('meldet nichts, wenn die Datei im Ref fehlt (aelterer main)', () => {
    const git = gitWith(new Error('path does not exist'));
    const read = () => 'irgendwas';
    expect(shimDriftReason(SHIM, 'origin/main', git, read)).toBe('');
  });

  // Auf Linux gibt es den Shim gar nicht -- systemd startet claude-runner.sh
  // direkt. Ein fehlender Shim ist dort kein Fehler.
  it('meldet nichts, wenn keine Datei installiert ist', () => {
    const git = gitWith('#!/usr/bin/env bash\necho hi');
    const read = () => {
      throw new Error('ENOENT');
    };
    expect(shimDriftReason(SHIM, 'origin/main', git, read)).toBe('');
  });

  it('meldet nichts ohne Pfad', () => {
    const git = gitWith('#!/usr/bin/env bash\necho hi');
    expect(shimDriftReason('', 'origin/main', git, () => 'x')).toBe('');
  });
});
