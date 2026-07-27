// Der Wortlaut der Agenten-Prompts ist Verhalten, kein Text: er steuert einen
// unbeaufsichtigten Lauf. Diese Suite haelt die Zusagen fest, die beim Port
// aus den Bash-Heredocs (#203, S6) wortgleich uebernommen wurden -- gepruefte
// Gleichheit gegen die alten Heredocs zum Portzeitpunkt, danach hier
// festgenagelt.
import { describe, expect, it } from 'vitest';
import { BUILD_TOOLS, READONLY_TOOLS, buildPrompt, ciFixPrompt, planPrompt, researchPrompt } from './prompts.js';

const ALL = [
  ['build', buildPrompt(42)],
  ['ci-fix', ciFixPrompt(42, 'egal')],
  ['plan', planPrompt(42)],
  ['research', researchPrompt(42)],
] as const;

describe('prompts', () => {
  it.each(ALL)('%s nennt die Ticketnummer und arbeitet unbeaufsichtigt', (_name, prompt) => {
    // Die Denk-Rollen schreiben die Nummer ohne Raute ('gh issue view 42'),
    // die Bau-Rollen mit -- beides wortgleich aus den Bash-Heredocs uebernommen.
    expect(prompt).toContain('42');
    expect(prompt).toContain('UNBEAUFSICHTIGT');
  });

  // #38: ein rekursiver Suchlauf ueber $HOME oder /Volumes loest auf macOS
  // einen modalen TCC-Dialog aus und blockiert den Lauf bis zur Notbremse.
  it.each(ALL)('%s verbietet Suchen ausserhalb des Repos', (_name, prompt) => {
    expect(prompt).toContain('Dateizugriff bleibt im Repo');
    expect(prompt).toContain("kein 'find', 'grep -r'");
    expect(prompt).toContain('/Volumes');
    expect(prompt).toContain('#38');
  });

  // Der Recherche-Prompt fehlt hier bewusst: er enthaelt den Satz nicht, und
  // S6 portiert wortgleich statt zu verbessern (AK3, Verhalten identisch).
  // Ob er ihn bekommen sollte, ist ein eigenes Ticket wert, kein Port-Fund.
  it.each([
    ['build', buildPrompt(42)],
    ['ci-fix', ciFixPrompt(42, 'egal')],
    ['plan', planPrompt(42)],
  ] as const)('%s laesst nie raten', (_name, prompt) => {
    expect(prompt).toMatch(/Rate (niemals|nie)/);
  });

  describe('Bau-Prompt', () => {
    const prompt = buildPrompt(7);

    it('haelt die Pflichtlektuere klein (Token-Disziplin)', () => {
      expect(prompt).toContain('Pflichtlektüre ist NUR CLAUDE.md und docs/CODEMAP.md');
      expect(prompt).toContain('nie das halbe Repo');
    });

    it('verlangt die schnellen Tore lokal, aber kein volles e2e', () => {
      expect(prompt).toContain("'pnpm lint', 'pnpm typecheck', 'pnpm test'");
      expect(prompt).toContain("Kein voller 'pnpm e2e' lokal");
      expect(prompt).toContain("**Kein** 'gh pr checks --watch'");
    });

    // #191: der Agent zieht main selbst nach, damit der PR nicht schon als
    // 'behind' entsteht -- pr_catch_up_behind bleibt nur das Netz dahinter.
    it('verlangt das proaktive Nachziehen von main vor dem finalen Push', () => {
      expect(prompt).toContain("'git fetch origin main' + 'git merge origin/main");
      expect(prompt).toContain('niemals in einen unsauberen');
    });

    // Geschuetzte Pfade: das Ticket wird SOFORT geparkt (#145), weil der Agent
    // das rote CI-Ergebnis nicht mehr live mitbekommt.
    it('laesst geschuetzte Pfade selbst needs-input setzen', () => {
      expect(prompt).toContain('src/db/, src/crypto/');
      expect(prompt).toContain("gh issue edit 7 --add-label needs-input");
      expect(prompt).toContain('NICHT wieder ab');
    });

    // #167: der Agent hebt seinen PR selbst aus dem Entwurf.
    it('hebt den PR selbst aus dem Entwurf und aktiviert Auto-Merge', () => {
      expect(prompt).toContain("'gh pr ready'");
      expect(prompt).toContain("'gh pr merge --squash --auto --delete-branch'");
    });

    it('verlangt den wachsenden Abschnitt "Was schon versucht wurde"', () => {
      expect(prompt).toContain('## Was schon versucht');
      expect(prompt).toContain('nie ueberschrieben');
    });
  });

  describe('CI-Fix-Prompt', () => {
    it('traegt die Fehlerursache woertlich in den Prompt', () => {
      expect(ciFixPrompt(7, 'shell.spec.ts:114 rot — Header-Aktivzustand')).toContain(
        'shell.spec.ts:114 rot — Header-Aktivzustand',
      );
    });

    // Regel 5 aus CLAUDE.md, woertlich im Prompt -- der Agent hat hier den
    // staerksten Anreiz, den Test statt die Ursache zu reparieren.
    it('verbietet das Aufweichen des Tests ausdruecklich', () => {
      const prompt = ciFixPrompt(7, 'egal');
      expect(prompt).toContain('NIE den Test aufweichen');
      expect(prompt).toContain("'.skip'");
      expect(prompt).toContain('kein hochgesetzter Timeout');
      expect(prompt).toContain('kein gelockertes Assert');
      expect(prompt).toContain("'waitForTimeout'");
      expect(prompt).toContain('erst den Trace lesen');
    });

    it('oeffnet keinen zweiten PR', () => {
      expect(ciFixPrompt(7, 'egal')).toContain('Kein neuer PR');
    });
  });

  describe('Denk-Rollen (ADR-0005)', () => {
    it.each([
      ['plan', planPrompt(7)],
      ['research', researchPrompt(7)],
    ])('%s aendert keinen Code', (_name, prompt) => {
      expect(prompt).toContain('nur lesend');
      expect(prompt).toContain('Ändere KEINEN');
      expect(prompt).toContain('committe NICHT');
    });

    // Das Label flippt ERST am Ende -- ein abgebrochener Denk-Lauf darf ein
    // Ticket nie als baubereit zuruecklassen.
    it('flippt needs-plan erst am Ende auf ready', () => {
      expect(planPrompt(7)).toContain('gh issue edit 7 --remove-label needs-plan --add-label\n   ready');
      expect(planPrompt(7)).toContain('Erst dieser abschließende Schritt flippt das Label');
    });

    it('flippt needs-research auf needs-input, nicht auf ready', () => {
      expect(researchPrompt(7)).toContain('--remove-label needs-research --add-label needs-input');
      expect(researchPrompt(7)).toContain('der Mensch entscheidet');
    });

    // #43: eine Idee, die der Vision widerspricht, wird benannt und dem
    // Menschen vorgelegt -- nicht eigenmaechtig verworfen.
    it('verwirft eine visionsfremde Idee nicht eigenmaechtig', () => {
      expect(researchPrompt(7)).toContain('nicht eigenmächtig verwerfen');
    });

    it('haelt die Planer-Rolle bei dateiweisen Plaenen, die Recherche darueber', () => {
      expect(planPrompt(7)).toContain('**dateiweisen** Umsetzungsplan');
      expect(researchPrompt(7)).toContain('**Kein Code, keine\n   dateiweise Umsetzung**');
    });
  });

  describe('Werkzeug-Allowlisten (ADR-0005 + #63)', () => {
    it('gibt den Denk-Rollen keinen pauschalen Bash-Zugriff', () => {
      expect(READONLY_TOOLS).not.toContain('Edit');
      expect(READONLY_TOOLS).not.toContain('Write');
      expect(READONLY_TOOLS.split(',')).not.toContain('Bash');
      expect(READONLY_TOOLS).toContain('Bash(gh:*)');
      expect(READONLY_TOOLS).toContain('Bash(git log:*)');
    });

    it('gibt der Bau-Rolle Schreibrechte', () => {
      expect(BUILD_TOOLS.split(',')).toContain('Edit');
      expect(BUILD_TOOLS.split(',')).toContain('Write');
      expect(BUILD_TOOLS.split(',')).toContain('Bash');
    });
  });
});
