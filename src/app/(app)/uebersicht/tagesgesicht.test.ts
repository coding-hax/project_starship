import { describe, expect, it } from 'vitest';
import type { TagesgesichtBlock } from '@/ui/faces';
import { tagesgesichtIndexFor } from './tagesgesicht';

const BLOECKE: TagesgesichtBlock[] = ['morgen', 'mittag', 'abend', 'nacht'];
// Vielfaches von 8, damit Tagesnummer 0 exakt auf einer Rundengrenze liegt —
// sonst verzerrt schon die Chunk-Bildung im Test das Ergebnis (AK2-Blocker).
const TAGE = 800;

describe('tagesgesichtIndexFor (issue #864, AK3)', () => {
  for (const block of BLOECKE) {
    describe(`Block ${block}`, () => {
      const folge = Array.from({ length: TAGE }, (_, tagesnummer) =>
        tagesgesichtIndexFor(tagesnummer, block),
      );

      it('jede 8er-Runde enthält jede der acht Figuren genau einmal', () => {
        for (let runde = 0; runde < TAGE / 8; runde++) {
          const ausschnitt = folge.slice(runde * 8, runde * 8 + 8);
          expect(new Set(ausschnitt)).toEqual(new Set([0, 1, 2, 3, 4, 5, 6, 7]));
        }
      });

      it('nie zwei gleiche hintereinander — auch nicht über die Rundengrenze', () => {
        for (let tagesnummer = 1; tagesnummer < TAGE; tagesnummer++) {
          expect(folge[tagesnummer]).not.toBe(folge[tagesnummer - 1]);
        }
      });

      it('gleicher Tag + gleicher Block liefert bei zweimaligem Aufruf dasselbe Ergebnis', () => {
        for (let tagesnummer = 0; tagesnummer < TAGE; tagesnummer += 37) {
          expect(tagesgesichtIndexFor(tagesnummer, block)).toBe(tagesgesichtIndexFor(tagesnummer, block));
        }
      });
    });
  }
});
