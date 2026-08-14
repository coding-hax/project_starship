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

    // #606: pnpm install mit cwd im Worktree schreibt dessen Top-Level-Links
    // relativ zum Worktree -- die bleiben nach 'git worktree remove' tot
    // zurueck und toeten den Runner still (Vorfall vom 10.08.26).
    it('verlangt pnpm install nur im Haupt-Checkout, nie mit cwd im Worktree', () => {
      expect(prompt).toContain('--dir <Haupt-Checkout>');
      expect(prompt).toContain('nie mit cwd in einem Worktree');
    });

    // #191: der Agent zieht main selbst nach, damit der PR nicht schon als
    // 'behind' entsteht -- pr_catch_up_behind bleibt nur das Netz dahinter.
    it('verlangt das proaktive Nachziehen von main vor dem finalen Push', () => {
      expect(prompt).toContain("'git fetch origin main' + 'git merge origin/main");
      expect(prompt).toContain('niemals in einen unsauberen');
    });

    // Geschuetzte Pfade: das Ticket wird SOFORT geparkt (#145), weil der Agent
    // das rote CI-Ergebnis nicht mehr live mitbekommt.
    // #283: Bis heute stand hier das Gegenteil -- der Prompt liess den Agenten
    // bei jedem sensiblen Pfad SELBST 'needs-answer' setzen und damit das
    // Ticket anhalten. Das war die Begleitmusik zum Waechter 'protected-paths':
    // der PR waere ohnehin rot geblieben, bis ein Mensch freigibt. Ohne
    // Waechter halt es nur noch ein Ticket an, ueber das niemand zu
    // entscheiden hat.
    it('verlangt bei sensiblen Pfaden einen Kommentar am Ticket', () => {
      expect(prompt).toContain('src/db/, src/crypto/');
      expect(prompt).toContain('kommentiere JETZT am Issue');
      expect(prompt).toContain('Datenverlust');
    });

    it('laesst den Agenten dafuer KEIN Wartelabel mehr setzen', () => {
      expect(prompt).not.toContain('--add-label needs-answer');
      expect(prompt).not.toContain('NICHT wieder ab');
    });

    // Die Ausnahme bleibt: inhaltliche Unsicherheit ist weiterhin ein Fall
    // zum Fragen -- nur eben nicht der blosse Dateipfad.
    it('haelt am Fragen bei inhaltlicher Unsicherheit fest', () => {
      expect(prompt).toContain('fragen statt raten');
    });

    // #167: der Agent hebt seinen PR selbst aus dem Entwurf.
    it('hebt den PR selbst aus dem Entwurf und aktiviert Auto-Merge', () => {
      expect(prompt).toContain("'gh pr ready'");
      expect(prompt).toContain("'gh pr merge --squash --auto --delete-branch'");
    });

    // #292: ohne --subject nimmt GitHub bei genau einem Commit auf dem
    // Branch dessen Commit-Nachricht statt des PR-Titels als Squash-Betreff
    // -- ein nur im Titel stehendes 'Closes #N' geht dann verloren.
    it('haengt --subject/--body an den Merge-Aufruf, damit Closes #N nicht verloren geht', () => {
      expect(prompt).toContain('--subject "$(gh pr view --json title -q .title)"');
      expect(prompt).toContain('--body ""');
    });

    it('verlangt den wachsenden Abschnitt "Was schon versucht wurde"', () => {
      expect(prompt).toContain('## Was schon versucht');
      expect(prompt).toContain('nie ueberschrieben');
    });
  });


  // #588: der Lauf legt keine Fund-Tickets mehr an. Der Prompt muss das
  // ausdruecklich verbieten UND den Ersatzweg nennen -- ein blosses Weglassen
  // der alten Anleitung wuerde den Agenten raten lassen, und "gh issue create"
  // ist die naheliegendste Vermutung.
  describe('Keine Fund-Tickets (#588)', () => {
    it.each([
      ['build', buildPrompt(42)],
      ['ci-fix', ciFixPrompt(42, 'egal')],
    ] as const)('%s-Prompt verbietet das Anlegen von Fund-Tickets', (_name, prompt) => {
      expect(prompt).toContain('## Funde: kein neues Ticket');
      expect(prompt).toContain('Du legst **keine** Fund-Tickets an');
      expect(prompt).toContain('Kein `gh issue create`');
    });

    it.each([
      ['build', buildPrompt(42)],
      ['ci-fix', ciFixPrompt(42, 'egal')],
    ] as const)('%s-Prompt nennt den Fortschrittskommentar als Ersatzweg', (_name, prompt) => {
      expect(prompt).toContain('## Funde nebenbei');
      expect(prompt).toContain('Fortschrittskommentar');
    });

    // Die abgeschaffte Maschinerie darf nicht als Restwortlaut zurueckkommen:
    // beide Abschnitte hatten eigene Ueberschriften, an denen sich das
    // zuverlaessig festmachen laesst.
    it.each([
      ['build', buildPrompt(42)],
      ['ci-fix', ciFixPrompt(42, 'egal')],
    ] as const)('%s-Prompt enthaelt die alte Fund-Ticket-Anleitung nicht mehr', (_name, prompt) => {
      expect(prompt).not.toContain('## Fund-Tickets anlegen');
      expect(prompt).not.toContain('Bekannte Fund-Tickets');
      expect(prompt).not.toContain('Fundschlüssel');
      expect(prompt).not.toContain('docs/workflow/fundschluessel.md');
      expect(prompt).not.toContain('Geschwister:');
    });

    // Der Fund darf den Auftrag nicht kapern -- das war der andere Schaden
    // der alten Regel: ein Lauf, der auf halbem Weg Fund-Tickets sortierte.
    it('haelt fest, dass ein Fund den Auftrag nicht aendert', () => {
      expect(buildPrompt(42)).toContain('ein Fund\nist kein Auftrag');
    });
  });

  // #439: vom Planer beim Aufteilen angelegte Kinder-Tickets tragen
  // automatisch `plan` -- sonst landen sie labellos und werden von
  // selectTicket nie aufgegriffen. Das ist seit #588 die einzige Stelle,
  // an der ein Lauf ueberhaupt noch ein Ticket anlegt.
  describe('Kinder-Tickets tragen plan (#439)', () => {
    const prompt = planPrompt(42);

    it('Plan-Prompt verlangt --label plan und Eltern-Verweis fuer selbst angelegte Kinder-Tickets', () => {
      expect(prompt).toContain('--label plan');
      expect(prompt).toContain('#42');
      expect(prompt).toContain('nur selbst angelegte');
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

    // #283: der Prompt darf keinen Waechter mehr versprechen, den es nicht
    // gibt -- ein roter Check ist ab jetzt ausnahmslos ein Fund.
    it('behauptet nicht mehr, ein geschuetzter Pfad halte den PR auf', () => {
      expect(buildPrompt(7)).not.toContain('protected-paths');
      expect(ciFixPrompt(7, 'egal')).not.toContain('protected-paths');
    });

    it('oeffnet keinen zweiten PR', () => {
      expect(ciFixPrompt(7, 'egal')).toContain('Kein neuer PR');
    });

    // #292: derselbe Schutz wie im Bau-Prompt -- der CI-Fix-Lauf mergt
    // ebenfalls selbst und darf das Closes #N nicht verlieren.
    it('haengt --subject/--body an den Merge-Aufruf, damit Closes #N nicht verloren geht', () => {
      const prompt = ciFixPrompt(7, 'egal');
      expect(prompt).toContain("'gh pr merge --squash --auto --delete-branch'");
      expect(prompt).toContain('--subject "$(gh pr view --json title -q .title)"');
      expect(prompt).toContain('--body ""');
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
    it('flippt plan erst am Ende auf ready', () => {
      expect(planPrompt(7)).toContain('gh issue edit 7 --remove-label plan\n   --remove-label in-progress --add-label ready');
      expect(planPrompt(7)).toContain('Erst dieser abschließende Schritt flippt das Label');
    });

    it('flippt research auf needs-answer, nicht auf ready', () => {
      expect(researchPrompt(7)).toContain('--remove-label research --remove-label in-progress\n   --add-label needs-answer');
      expect(researchPrompt(7)).toContain('der Mensch entscheidet');
    });

    // #387 AC4: der Prompt selbst nennt das Entfernen von in-progress beim
    // abschliessenden Flip -- der Runner-Backstop in round.ts greift nur,
    // falls ein Lauf das vergisst oder abbricht.
    it('#387: nennt beim Flip explizit das Entfernen von in-progress (Denk-Lauf zu Ende)', () => {
      expect(planPrompt(7)).toContain('--remove-label in-progress');
      expect(planPrompt(7)).toContain('der Denk-Lauf ist zu Ende');
      expect(researchPrompt(7)).toContain('--remove-label in-progress');
      expect(researchPrompt(7)).toContain('der Denk-Lauf ist zu Ende');
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

    // #326: #216 legte am 28.07.26 seine drei Bau-Tickets doppelt an -- der
    // Planer-Lauf prüfte vor 'gh issue create' nicht, ob sie schon existieren.
    it('verlangt eine Duplikat-Pruefung, bevor der Planer Folge-Tickets anlegt', () => {
      const prompt = planPrompt(7);
      expect(prompt).toContain('Folge-/Kind-Tickets');
      expect(prompt).toContain('gh issue list --search "#7" --state open');
      expect(prompt).toContain('lege **nichts neu an**');
      expect(prompt).toContain('nenne die gefundenen');
    });

    it('gilt die Duplikat-Pruefung ausdruecklich auch bei einer fortgesetzten Session', () => {
      expect(planPrompt(7)).toContain('nicht nur beim ersten\n   Anlauf');
    });

    // #724 (S1 von ADR-0023, AK6): die Kette zwischen Kind-Tickets steht ab
    // jetzt am Kind selbst, nicht mehr nur im Queue-Issue.
    it('verlangt eine "Nach: #<Vorgaenger>"-Zeile fuer aufeinander aufbauende Kind-Tickets', () => {
      expect(planPrompt(7)).toContain("trage 'Nach: #<Vorgänger>' als eigene Zeile");
      expect(planPrompt(7)).toContain('im selben Schritt, in dem du es\n   anlegst, nicht nachträglich');
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
