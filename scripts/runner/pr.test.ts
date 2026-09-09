import { describe, expect, it, vi } from 'vitest';
import type { GhAdapter } from './gh';
import {
  prCiState,
  prFailureSummary,
  prForIssue,
  prIsBehind,
  prIsDirty,
  prMergeState,
  prSquashMerge,
  reopenFalselyClosedIssues,
} from './pr';

function ghRouter(routes: Record<string, string>): GhAdapter {
  return {
    run: vi.fn((args: string[]) => {
      const key = args.join(' ');
      for (const [pattern, out] of Object.entries(routes)) {
        if (key.startsWith(pattern)) return out;
      }
      throw new Error(`kein Route-Stub fuer: ${key}`);
    }),
  };
}

describe('prForIssue', () => {
  it('findet die PR-Nummer ueber die Branch-Konvention feat/fix/chore', () => {
    const gh = ghRouter({
      'pr list': JSON.stringify([
        { number: 55, headRefName: 'fix/201-runner-ci-watch' },
        { number: 56, headRefName: 'feat/999-irgendwas' },
      ]),
    });
    expect(prForIssue(201, gh)).toBe('55');
  });

  it('liefert leer, wenn kein Branch passt', () => {
    const gh = ghRouter({ 'pr list': '[]' });
    expect(prForIssue(201, gh)).toBe('');
  });

  it('liefert leer statt zu werfen, wenn gh scheitert', () => {
    const gh: GhAdapter = {
      run: vi.fn(() => {
        throw new Error('gh failed');
      }),
    };
    expect(prForIssue(201, gh)).toBe('');
  });
});

describe('prMergeState / prIsBehind', () => {
  it('parst headRefName + mergeStateStatus', () => {
    const gh = ghRouter({ 'pr view': JSON.stringify({ headRefName: 'fix/1-x', mergeStateStatus: 'BEHIND' }) });
    expect(prMergeState('55', gh)).toEqual({ headRefName: 'fix/1-x', mergeStateStatus: 'BEHIND' });
    expect(prIsBehind('55', gh)).toBe(true);
  });

  // #880: der Entwurfsstatus reist auf demselben `gh pr view` mit -- `isDraft`
  // steht in der Feldliste, kein zusaetzlicher gh-Aufruf. Daran haengt die
  // CI-Wache ihren Riegel (statt ans Label 'check').
  it('#880: liest isDraft aus demselben pr view mit -- isDraft in der Feldliste', () => {
    const gh = ghRouter({ 'pr view': JSON.stringify({ headRefName: 'fix/1-x', mergeStateStatus: 'CLEAN', isDraft: true }) });
    expect(prMergeState('55', gh)?.isDraft).toBe(true);
    // Genau EIN `pr view`, und es fragt isDraft ab (nicht ueber einen zweiten Aufruf).
    expect(gh.run).toHaveBeenCalledTimes(1);
    expect(gh.run).toHaveBeenCalledWith(['pr', 'view', '55', '--json', 'headRefName,mergeStateStatus,isDraft']);
  });

  it('#880: ein nicht-Entwurf meldet isDraft:false', () => {
    const gh = ghRouter({ 'pr view': JSON.stringify({ headRefName: 'fix/1-x', mergeStateStatus: 'CLEAN', isDraft: false }) });
    expect(prMergeState('55', gh)?.isDraft).toBe(false);
  });

  it('CLEAN ist nicht behind', () => {
    const gh = ghRouter({ 'pr view': JSON.stringify({ headRefName: 'fix/1-x', mergeStateStatus: 'CLEAN' }) });
    expect(prIsBehind('55', gh)).toBe(false);
  });

  it('liefert null, wenn gh scheitert', () => {
    const gh: GhAdapter = {
      run: vi.fn(() => {
        throw new Error('gh failed');
      }),
    };
    expect(prMergeState('55', gh)).toBeNull();
    expect(prIsBehind('55', gh)).toBe(false);
  });
});

describe('prCiState', () => {
  it('keine Checks -> pending', () => {
    const gh = ghRouter({ 'pr checks': '[]' });
    expect(prCiState('55', gh)).toBe('pending');
  });

  it('pending hat Vorrang vor failing (#160)', () => {
    const gh = ghRouter({
      'pr checks': JSON.stringify([
        { bucket: 'fail', name: 'e2e' },
        { bucket: 'pending', name: 'quality' },
      ]),
    });
    expect(prCiState('55', gh)).toBe('pending');
  });

  it('failing, wenn nichts mehr pending ist', () => {
    const gh = ghRouter({
      'pr checks': JSON.stringify([
        { bucket: 'pass', name: 'quality' },
        { bucket: 'fail', name: 'e2e' },
      ]),
    });
    expect(prCiState('55', gh)).toBe('failing');
  });

  it('behind erst geprueft, wenn alles gruen/nicht-pending ist', () => {
    const gh = ghRouter({
      'pr checks': JSON.stringify([{ bucket: 'pass', name: 'quality' }]),
      'pr view': JSON.stringify({ headRefName: 'fix/1-x', mergeStateStatus: 'BEHIND' }),
    });
    expect(prCiState('55', gh)).toBe('behind');
  });

  it('success, wenn alles gruen und nicht behind ist', () => {
    const gh = ghRouter({
      'pr checks': JSON.stringify([{ bucket: 'pass', name: 'quality' }]),
      'pr view': JSON.stringify({ headRefName: 'fix/1-x', mergeStateStatus: 'CLEAN' }),
    });
    expect(prCiState('55', gh)).toBe('success');
  });

  // #217 AC1: der eigentliche Fund des Tickets -- ein DIRTY-PR mit gruenen
  // Checks fiel vorher auf 'success' durch, weil GitHub fuer ihn nie mehr
  // 'BEHIND' meldet. Der Runner hat ihn dann Takt fuer Takt vergeblich zu
  // mergen versucht.
  it('conflict statt success, wenn der PR DIRTY ist und alle Checks gruen sind (#217)', () => {
    const gh = ghRouter({
      'pr checks': JSON.stringify([{ bucket: 'pass', name: 'quality' }]),
      'pr view': JSON.stringify({ headRefName: 'fix/1-x', mergeStateStatus: 'DIRTY' }),
    });
    expect(prCiState('55', gh)).toBe('conflict');
  });

  it('pending und failing haben weiterhin Vorrang vor conflict (#217)', () => {
    const pending = ghRouter({
      'pr checks': JSON.stringify([{ bucket: 'pending', name: 'e2e' }]),
      'pr view': JSON.stringify({ headRefName: 'fix/1-x', mergeStateStatus: 'DIRTY' }),
    });
    expect(prCiState('55', pending)).toBe('pending');

    const failing = ghRouter({
      'pr checks': JSON.stringify([{ bucket: 'fail', name: 'e2e' }]),
      'pr view': JSON.stringify({ headRefName: 'fix/1-x', mergeStateStatus: 'DIRTY' }),
    });
    expect(prCiState('55', failing)).toBe('failing');
  });
});

describe('prIsDirty', () => {
  it('DIRTY ist ein Konflikt', () => {
    const gh = ghRouter({ 'pr view': JSON.stringify({ headRefName: 'fix/1-x', mergeStateStatus: 'DIRTY' }) });
    expect(prIsDirty('55', gh)).toBe(true);
  });

  it('BEHIND und CLEAN sind kein Konflikt', () => {
    const behind = ghRouter({ 'pr view': JSON.stringify({ headRefName: 'fix/1-x', mergeStateStatus: 'BEHIND' }) });
    expect(prIsDirty('55', behind)).toBe(false);
    const clean = ghRouter({ 'pr view': JSON.stringify({ headRefName: 'fix/1-x', mergeStateStatus: 'CLEAN' }) });
    expect(prIsDirty('55', clean)).toBe(false);
  });

  it('kein Konflikt, wenn gh scheitert', () => {
    const gh: GhAdapter = {
      run: vi.fn(() => {
        throw new Error('gh failed');
      }),
    };
    expect(prIsDirty('55', gh)).toBe(false);
  });
});

describe('prSquashMerge', () => {
  it('uebergibt den PR-Titel als --subject und leeres --body', () => {
    const gh = ghRouter({ 'pr view': 'fix(runner): needs-input — Closes #163' });
    prSquashMerge('55', gh);
    expect(gh.run).toHaveBeenCalledWith([
      'pr',
      'merge',
      '--squash',
      '--auto',
      '--delete-branch',
      '--subject',
      'fix(runner): needs-input — Closes #163',
      '--body',
      '',
      '55',
    ]);
  });

  it('faellt ohne ermittelbaren Titel auf den blanken Merge-Aufruf zurueck', () => {
    const gh: GhAdapter = {
      run: vi.fn((args: string[]) => {
        if (args[0] === 'pr' && args[1] === 'view') return '';
        return '';
      }),
    };
    prSquashMerge('56', gh);
    expect(gh.run).toHaveBeenCalledWith(['pr', 'merge', '--squash', '--auto', '--delete-branch', '56']);
  });

  // #217 AC4: der Rueckgabewert ist die Grundlage dafuer, ob 'parked' bzw.
  // 'needs-input' ueberhaupt entfernt werden duerfen.
  it('wirft nicht weiter, aber meldet false, wenn der Merge-Aufruf selbst scheitert (#217)', () => {
    const gh: GhAdapter = {
      run: vi.fn((args: string[]) => {
        if (args[0] === 'pr' && args[1] === 'view') return 'title';
        throw new Error('merge failed');
      }),
    };
    let result: boolean | undefined;
    expect(() => {
      result = prSquashMerge('57', gh);
    }).not.toThrow();
    expect(result).toBe(false);
  });

  it('meldet true, wenn der Merge-Aufruf durchgeht (#217)', () => {
    const gh = ghRouter({ 'pr view': 'fix(runner): x — Closes #1', 'pr merge': '' });
    expect(prSquashMerge('58', gh)).toBe(true);
  });
});

describe('reopenFalselyClosedIssues', () => {
  it('oeffnet ein faelschlich geschlossenes Ticket wieder und kommentiert den Grund', () => {
    const gh: GhAdapter = {
      run: vi.fn((args: string[]) => {
        const key = args.join(' ');
        if (key.startsWith('pr list')) {
          return JSON.stringify([
            { number: 166, title: 'fix(runner): needs-input bei geschützten Pfaden — Closes #163' },
            { number: 170, title: 'feat(weather): Feinschliff — Closes #155' },
          ]);
        }
        if (key.startsWith('issue view 163')) return 'CLOSED';
        if (key.startsWith('issue view 155')) return 'OPEN';
        if (key.startsWith('pr view 166')) return 'OPEN';
        return '';
      }),
    };

    reopenFalselyClosedIssues(gh);

    expect(gh.run).toHaveBeenCalledWith(['issue', 'reopen', '163']);
    expect(gh.run).not.toHaveBeenCalledWith(['issue', 'reopen', '155']);
    expect(gh.run).toHaveBeenCalledWith(['issue', 'comment', '163', '--body', expect.stringContaining('#166')]);
  });

  it('reopnt NICHT, wenn der gelistete PR inzwischen selbst gemergt ist (#531)', () => {
    const gh: GhAdapter = {
      run: vi.fn((args: string[]) => {
        const key = args.join(' ');
        if (key.startsWith('pr list')) {
          return JSON.stringify([
            { number: 524, title: 'fix(sync): pull is paginated with a keyset LIMIT — Closes #478' },
          ]);
        }
        if (key.startsWith('issue view 478')) return 'CLOSED';
        if (key.startsWith('pr view 524')) return 'MERGED';
        return '';
      }),
    };

    reopenFalselyClosedIssues(gh);

    expect(gh.run).not.toHaveBeenCalledWith(['issue', 'reopen', '478']);
    expect(gh.run).not.toHaveBeenCalledWith(['issue', 'comment', '478', expect.anything(), expect.anything()]);
  });

  it('reopnt nicht, wenn die PR-Statusabfrage scheitert (fail-safe)', () => {
    const gh: GhAdapter = {
      run: vi.fn((args: string[]) => {
        const key = args.join(' ');
        if (key.startsWith('pr list')) {
          return JSON.stringify([{ number: 166, title: 'fix: x — Closes #163' }]);
        }
        if (key.startsWith('issue view 163')) return 'CLOSED';
        if (key.startsWith('pr view 166')) throw new Error('gh timeout');
        return '';
      }),
    };

    reopenFalselyClosedIssues(gh);

    expect(gh.run).not.toHaveBeenCalledWith(['issue', 'reopen', '163']);
  });

  it('laesst ein bereits offenes Ticket unangetastet', () => {
    const gh: GhAdapter = {
      run: vi.fn((args: string[]) => {
        const key = args.join(' ');
        if (key.startsWith('pr list')) {
          return JSON.stringify([{ number: 166, title: 'fix: x — Closes #163' }]);
        }
        if (key.startsWith('issue view')) return 'OPEN';
        return '';
      }),
    };

    reopenFalselyClosedIssues(gh);

    expect(gh.run).not.toHaveBeenCalledWith(['issue', 'reopen', '163']);
  });

  it('ueberlebt eine leere/kaputte PR-Liste', () => {
    const gh: GhAdapter = {
      run: vi.fn(() => {
        throw new Error('gh failed');
      }),
    };
    expect(() => reopenFalselyClosedIssues(gh)).not.toThrow();
  });
});

describe('prFailureSummary', () => {
  // #283: Bis heute nahm diese Zusammenfassung 'protected-paths' bewusst aus --
  // der Check war eine Genehmigungs-Schranke, kein Fund, den ein Agent haette
  // beheben koennen. Den Job gibt es nicht mehr, also gilt wieder die einfache
  // Regel: jeder rote Check ist ein Fund, gedeckelt auf die ersten drei.
  it('nennt Job, Kurzbeschreibung, Link und Log-Ausschnitt, hoechstens die ersten drei roten Checks', () => {
    const checks = [
      { bucket: 'fail', name: 'e2e', description: '2 tests failed in shard 2', link: 'https://x/actions/runs/999999/job/111' },
      { bucket: 'fail', name: 'lint', description: 'eslint rot' },
      { bucket: 'fail', name: 'typecheck', description: 'tsc rot' },
      { bucket: 'cancel', name: 'e2e-2', description: 'abgebrochen' },
    ];
    const gh: GhAdapter = {
      run: vi.fn((args: string[]) => {
        const key = args.join(' ');
        if (key.startsWith('pr checks')) return JSON.stringify(checks);
        if (key.startsWith('run view 999999')) return 'e2e\tRun tests\t2024-01-01T00:00:00Z log line 1\ne2e\tRun tests\t2024-01-01T00:00:00Z log line 2';
        return '';
      }),
    };

    const summary = prFailureSummary('55', gh);

    expect(summary).toContain('### e2e');
    expect(summary).toContain('2 tests failed in shard 2');
    expect(summary).toContain('https://x/actions/runs/999999/job/111');
    expect(summary).toContain('log line 1');
    expect(summary).toContain('### lint');
    expect(summary).toContain('### typecheck');
    // Der vierte faellt raus -- sonst waechst der Auftrag mit jedem Shard --,
    // aber sichtbar vermerkt statt stillschweigend verschluckt (#1141 AC4).
    expect(summary).not.toContain('e2e-2');
    expect(summary).toContain('1 weitere(r) roter Check(s) gekürzt');
  });

  it('nimmt keinen Check mehr aus -- auch ein Check namens protected-paths zaehlt', () => {
    const gh = ghRouter({
      'pr checks': JSON.stringify([{ bucket: 'fail', name: 'protected-paths', description: 'irgendwas' }]),
    });
    expect(prFailureSummary('55', gh)).toContain('### protected-paths');
  });

  it('leer, wenn nichts rot ist', () => {
    const gh = ghRouter({ 'pr checks': JSON.stringify([{ bucket: 'pass', name: 'quality' }]) });
    expect(prFailureSummary('55', gh)).toBe('');
  });

  // #1141 AC1: drei Shards EINES Laufs teilen sich dieselbe runId im Link --
  // der teure `gh run view --log-failed`-Aufruf darf nur einmal passieren.
  it('holt den Workflow-Log nur einmal, wenn mehrere rote Checks dieselbe runId teilen', () => {
    const checks = [
      { bucket: 'fail', name: 'e2e-main (1)', description: 'shard 1 rot', link: 'https://x/actions/runs/555/job/1' },
      { bucket: 'fail', name: 'e2e-main (2)', description: 'shard 2 rot', link: 'https://x/actions/runs/555/job/2' },
    ];
    const runViewCalls: string[] = [];
    const gh: GhAdapter = {
      run: vi.fn((args: string[]) => {
        const key = args.join(' ');
        if (key.startsWith('pr checks')) return JSON.stringify(checks);
        if (key.startsWith('run view')) {
          runViewCalls.push(key);
          return 'e2e-main (1)\tRun tests\t... shard 1 failure\ne2e-main (2)\tRun tests\t... shard 2 failure';
        }
        return '';
      }),
    };

    prFailureSummary('55', gh);

    expect(runViewCalls).toEqual(['run view 555 --log-failed']);
  });

  // #1141 AC2: zwei verschiedene Jobs desselben Laufs behalten getrennte,
  // nach Job benannte Auszuege statt denselben Log-Schwanz doppelt zu tragen.
  it('sortiert den gemeinsamen Log nach Job-Namen auseinander, statt ihn zu duplizieren', () => {
    const checks = [
      { bucket: 'fail', name: 'e2e-main (1)', description: 'shard 1 rot', link: 'https://x/actions/runs/555/job/1' },
      { bucket: 'fail', name: 'e2e-main (2)', description: 'shard 2 rot', link: 'https://x/actions/runs/555/job/2' },
    ];
    const gh: GhAdapter = {
      run: vi.fn((args: string[]) => {
        const key = args.join(' ');
        if (key.startsWith('pr checks')) return JSON.stringify(checks);
        if (key.startsWith('run view')) {
          return [
            'e2e-main (1)\tRun tests\t... assertion failed in shard one',
            'e2e-main (2)\tRun tests\t... timeout in shard two',
          ].join('\n');
        }
        return '';
      }),
    };

    const summary = prFailureSummary('55', gh);
    const firstBlock = summary.split('### e2e-main (2)')[0];
    const secondBlock = summary.split('### e2e-main (2)')[1] ?? '';

    expect(firstBlock).toContain('assertion failed in shard one');
    expect(firstBlock).not.toContain('timeout in shard two');
    expect(secondBlock).toContain('timeout in shard two');
    expect(secondBlock).not.toContain('assertion failed in shard one');
  });

  // #1141 AC5: ein nicht abrufbarer Log stuerzt den Aufrufer nicht ab und wird
  // als Aussage im Auszug vermerkt statt kommentarlos zu fehlen.
  it('vermerkt einen nicht abrufbaren Log als Aussage, statt zu werfen', () => {
    const gh: GhAdapter = {
      run: vi.fn((args: string[]) => {
        const key = args.join(' ');
        if (key.startsWith('pr checks')) {
          return JSON.stringify([{ bucket: 'fail', name: 'e2e', description: 'rot', link: 'https://x/actions/runs/777/job/1' }]);
        }
        if (key.startsWith('run view')) throw new Error('gh timeout');
        return '';
      }),
    };

    let summary = '';
    expect(() => {
      summary = prFailureSummary('55', gh);
    }).not.toThrow();
    expect(summary).toContain('### e2e');
    expect(summary).toContain('nicht abrufbar');
  });

  // #1141 AC4: die Gesamtausgabe bleibt unter 8.192 UTF-8-Bytes und traegt am
  // Ende einen sichtbaren Kuerzungshinweis, wenn ein einzelner Log riesig ist.
  it('deckelt die Gesamtausgabe auf 8.192 UTF-8-Bytes mit sichtbarem Kuerzungshinweis', () => {
    // 25 Zeilen (der Deckel je Job) knapp unter der 1.024-Byte-Zeilengrenze,
    // damit die Zeilenkuerzung nicht zwischenfunkt und ausschliesslich der
    // Gesamt-Byte-Deckel greift -- 25 * ~950 Bytes liegt klar ueber 8.192.
    const hugeLog = Array.from({ length: 25 }, (_, i) => `e2e\tRun tests\t... Zeile ${i} ${'x'.repeat(900)}`).join('\n');
    const gh: GhAdapter = {
      run: vi.fn((args: string[]) => {
        const key = args.join(' ');
        if (key.startsWith('pr checks')) {
          return JSON.stringify([{ bucket: 'fail', name: 'e2e', description: 'rot', link: 'https://x/actions/runs/888/job/1' }]);
        }
        if (key.startsWith('run view')) return hugeLog;
        return '';
      }),
    };

    const summary = prFailureSummary('55', gh);

    expect(Buffer.byteLength(summary, 'utf-8')).toBeLessThanOrEqual(8192);
    expect(summary).toContain('gekürzt');
  });

  // #1141 AC4: eine einzelne, sehr lange Zeile wird an ihr selbst gekuerzt und
  // sichtbar markiert -- der Byte-Deckel ist keine Zeilen-Zaehlung.
  it('kuerzt eine einzelne, sehr lange Log-Zeile sichtbar', () => {
    const longLine = `e2e\tRun tests\t... ${'y'.repeat(5000)}`;
    const gh: GhAdapter = {
      run: vi.fn((args: string[]) => {
        const key = args.join(' ');
        if (key.startsWith('pr checks')) {
          return JSON.stringify([{ bucket: 'fail', name: 'e2e', description: 'rot', link: 'https://x/actions/runs/999/job/1' }]);
        }
        if (key.startsWith('run view')) return longLine;
        return '';
      }),
    };

    const summary = prFailureSummary('55', gh);

    expect(summary).toContain('[Zeile gekürzt]');
    expect(Buffer.byteLength(summary, 'utf-8')).toBeLessThanOrEqual(8192);
  });
});
