import { describe, expect, it } from 'vitest';
import { TagesgesichtFace, type TagesgesichtBlock } from './faces';

const BLOECKE: TagesgesichtBlock[] = ['morgen', 'mittag', 'abend', 'nacht'];

// Bauplan-Regression (issue #864, AK1): alle 32 Kombinationen aus Block ×
// Index müssen einen vollständigen Eintrag (Körper/Zubehör/Augen/Mund) im
// Bauplan haben. Wer Kombinationen (Ziehung, AK2) und Zeitverhalten (AK4)
// prüft `tagesgesicht.ts`, sobald die Ziehungsfunktion existiert — hier geht
// es nur um die Bausteine selbst.
describe('TagesgesichtFace', () => {
  it.each(BLOECKE)('rendert alle acht Figuren des Blocks %s ohne Fehler', (block) => {
    for (let index = 0; index < 8; index++) {
      const element = TagesgesichtFace({ block, index });
      expect(element.type).toBe('svg');
      expect(element.props.viewBox).toBe('0 0 64 64');
      expect(element.props['data-face']).toBe('uebersicht');
    }
  });
});
