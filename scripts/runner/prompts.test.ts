// Der Wortlaut der Agenten-Prompts ist Verhalten, kein Text: er steuert einen
// unbeaufsichtigten Lauf. Diese Suite haelt die Zusagen fest, die beim Port
// aus den Bash-Heredocs (#203, S6) wortgleich uebernommen wurden -- gepruefte
// Gleichheit gegen die alten Heredocs zum Portzeitpunkt, danach hier
// festgenagelt.
import { describe, expect, it } from 'vitest';
import {
  BUILD_TOOLS,
  CHECK_TOOLS,
  READONLY_TOOLS,
  buildPrompt,
  checkPrompt,
  ciFixPrompt,
  planPrompt,
  researchPrompt,
} from './prompts.js';

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
      expect(prompt).toContain("'gh pr checks --watch'");
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

    // #839: der Bau-Lauf mergt NICHT mehr selbst. Bis dahin hob er seinen
    // eigenen PR aus dem Entwurf (#167) -- derselbe Agent, der den Code
    // geschrieben hat, stellte damit auch fest, dass er fertig ist. Ab jetzt
    // gibt er an den AK-Check ab; das Tor ist ein eigener, nur lesender Lauf.
    it('gibt an den AK-Check ab, statt selbst zu mergen', () => {
      expect(prompt).toContain("'gh issue edit 7 --add-label check'");
      expect(prompt).toContain('bleibt Entwurf');
    });

    it('verbietet dem Bau-Lauf Freigabe und Merge ausdruecklich', () => {
      expect(prompt).toContain("**Kein** 'gh pr ready'");
      expect(prompt).toContain("**kein** 'gh pr merge'");
      expect(prompt).not.toContain('gh pr merge --squash --auto');
    });

    it('verlangt den wachsenden Abschnitt "Was schon versucht wurde"', () => {
      expect(prompt).toContain('## Was schon versucht');
      expect(prompt).toContain('nie ueberschrieben');
    });
  });


  // #839: der AK-Check ist das Tor vor dem Merge. Was hier festgenagelt ist,
  // sind genau die Zusagen, deren Verlust den Check wertlos machte: die
  // Kriterien kommen mitgeliefert (statt "lies sie dir raus"), er aendert
  // nichts, und die Merge-Aufrufe leben ab jetzt HIER statt im Bau-Prompt.
  describe('AK-Check-Prompt (#839)', () => {
    const criteria = ['Erstens tut es X.', 'Zweitens bleibt Y unberuehrt.'];
    const prompt = checkPrompt(42, criteria, 'feat/42-quick-add');

    it('nennt Ticket, Branch und die Kriterien in ihrer Nummerierung', () => {
      expect(prompt).toContain('#42');
      expect(prompt).toContain('feat/42-quick-add');
      expect(prompt).toContain('1. Erstens tut es X.');
      expect(prompt).toContain('2. Zweitens bleibt Y unberuehrt.');
    });

    it('ist nur lesend und baut ausdruecklich nicht nach', () => {
      expect(prompt).toContain('nur lesend');
      expect(prompt).toContain('Ändere KEINEN\nCode');
      expect(prompt).toContain('verbesserst nicht');
    });

    it('kennt genau drei Befunde und verbietet das Raten', () => {
      expect(prompt).toContain('**erfüllt**');
      expect(prompt).toContain('**nicht erfüllt**');
      expect(prompt).toContain('**nicht prüfbar**');
      expect(prompt).toContain('Rate nie');
    });

    // Der Fortschrittskommentar des Bau-Laufs ist KEIN Beleg -- sonst prueft
    // der Check die Selbstauskunft dessen, den er pruefen soll.
    it('erklaert den Haken des Bau-Laufs ausdruecklich fuer keinen Beleg', () => {
      expect(prompt).toContain('ist **kein** Beleg');
    });

    it('haelt den Diff gegen origin/main, nicht gegen den Arbeitsstand', () => {
      expect(prompt).toContain('git diff origin/main...HEAD');
    });

    // Wandert vom Bau- in den Pruef-Prompt (#167/#292): ohne --subject nimmt
    // GitHub bei genau einem Commit dessen Nachricht als Squash-Betreff, und
    // ein nur im Titel stehendes 'Closes #N' geht verloren.
    it('gibt den PR frei -- mit den Pflichtflags aus #292', () => {
      expect(prompt).toContain('gh pr ready');
      expect(prompt).toContain('gh pr merge --squash --auto --delete-branch');
      expect(prompt).toContain('--subject "$(gh pr view --json title -q .title)"');
      expect(prompt).toContain('--body ""');
      expect(prompt).toContain('#292');
    });

    it('nimmt bei einer Luecke das Label zurueck und laesst den PR im Entwurf', () => {
      expect(prompt).toContain('gh issue edit 42 --remove-label check');
      expect(prompt).toContain('der PR bleibt Entwurf');
      expect(prompt).toContain('Fortschrittskommentar');
    });

    it('endet beim zweiten vergeblichen Anlauf mit needs-answer statt einer dritten Runde', () => {
      expect(prompt).toContain('--add-label needs-answer');
      expect(prompt).toContain('zweite vergebliche Anlauf');
    });

    it('bekommt Lese-Werkzeuge plus git fetch, aber kein Edit und kein Artifact', () => {
      expect(CHECK_TOOLS).toContain(READONLY_TOOLS);
      expect(CHECK_TOOLS).toContain('Bash(git fetch:*)');
      expect(CHECK_TOOLS).not.toContain('Edit');
      expect(CHECK_TOOLS).not.toContain('Artifact');
    });
  });

  // #901: der Pruefer hinterlaesst IMMER eine sichtbare Anmerkung -- auch wenn
  // alles passt und er direkt freigibt -- und postet sie VOR dem Merge, sonst
  // laege sie auf einem bereits geschlossenen Ticket (oder gar nicht) vor.
  describe('AK-Check-Kommentar: immer, vor dem Merge, mit Kopfzeile (#901)', () => {
    const prompt = checkPrompt(42, ['A tut X', 'B bleibt Y'], 'feat/42-x');

    it('verlangt den Befund in jedem Ausgang, auch bei voller Erfuellung', () => {
      expect(prompt).toContain('in jedem Ausgang zuerst — auch bei voller Erfüllung');
    });

    it('verlangt den Kommentar vor Label-Aenderung und Merge', () => {
      expect(prompt).toContain('vor jeder Label-Änderung und vor dem Merge');
    });

    it('verlangt eine menschenlesbare Kopfzeile fuer den Happy Path', () => {
      expect(prompt).toContain('menschenlesbare Kopfzeile');
      expect(prompt).toContain('PR freigegeben');
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
    // #839: der CI-Fix-Lauf mergt genauso wenig selbst wie der Bau-Lauf --
    // er gibt an denselben AK-Check ab. Die Merge-Aufrufe samt --subject
    // stehen jetzt im Pruef-Prompt.
    it('gibt an den AK-Check ab, statt selbst zu mergen', () => {
      expect(ciFixPrompt(7, 'egal')).toContain("'gh issue edit 7 --add-label check'");
      expect(ciFixPrompt(7, 'egal')).not.toContain('gh pr merge --squash --auto');
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

    // #767 (ADR-0024): Artifact ist eine Runner-CLI-Allowlist-Zeile
    // (round.ts), keine der beiden hier exportierten Konstanten -- die
    // Bau-Rolle darf es nicht bekommen (AK4, Scope-Creep).
    it('nennt Artifact nicht in BUILD_TOOLS', () => {
      expect(BUILD_TOOLS.split(',')).not.toContain('Artifact');
    });
  });

  // #767 (ADR-0024): beide Denk-Rollen bekommen dieselbe Artifact-Leitplanke
  // im Prompt -- Wann/Wie/keine Nutzerdaten/URL-im-Kommentar (AK2/3/5/6/7).
  describe('Artifact-Leitplanke fuer Denk-Rollen (#767, ADR-0024)', () => {
    it.each([
      ['plan', planPrompt(7)],
      ['research', researchPrompt(7)],
    ] as const)('%s-Prompt nennt Wann/Wie und verweist auf ADR-0024', (_name, prompt) => {
      expect(prompt).toContain('**Wann:**');
      expect(prompt).toContain('**Wie:**');
      expect(prompt).toContain('ADR-0024');
    });

    it.each([
      ['plan', planPrompt(7)],
      ['research', researchPrompt(7)],
    ] as const)('%s-Prompt verbietet Nutzerdaten und Secrets im Artifact', (_name, prompt) => {
      expect(prompt).toContain('Journal-Inhalte');
      expect(prompt).toContain('Secrets');
    });

    it.each([
      ['plan', planPrompt(7)],
      ['research', researchPrompt(7)],
    ] as const)('%s-Prompt verlangt die URL im Kommentar und dasselbe Artifact bei Fortsetzung', (_name, prompt) => {
      expect(prompt).toContain('landet im Plan-/Rechercheergebnis-Kommentar');
      expect(prompt).toContain('**dasselbe** Artifact');
    });
  });

  // #907: die alte ARTIFACT_RULE versprach das Werkzeug bedingungslos --
  // #807 widerlegte das zweimal woertlich im unbeaufsichtigten Kontext,
  // obwohl die Allowlist stimmte. Die Regel kennt seither den beobachteten
  // Zustand, verlangt einen Artboard je Zustand statt einer Sammelskizze,
  // sagt Backend-Tickets ausdruecklich kein Entwurfsblatt zu und macht die
  // Artifact-Kommentare zum Rueckkanal.
  describe('Artifact: ehrliche Verfuegbarkeit + Artboard je Zustand + Rueckkanal (#907)', () => {
    it.each([
      ['plan', planPrompt(7)],
      ['research', researchPrompt(7)],
    ] as const)('%s-Prompt verspricht das Werkzeug nicht mehr bedingungslos und nennt den Ersatz', (_name, prompt) => {
      expect(prompt).toContain('kann dir zur\nVerfügung stehen');
      expect(prompt).not.toContain('steht dir zur\nVerfügung');
      expect(prompt).toContain('#807');
      expect(prompt).toContain('Artifact exists but\nis not enabled in this context');
      expect(prompt).toContain('Text-Skizze im Monospace-Block');
    });

    it.each([
      ['plan', planPrompt(7)],
      ['research', researchPrompt(7)],
    ] as const)('%s-Prompt verbietet den zweiten Versuch nach einer Ablehnung', (_name, prompt) => {
      expect(prompt).toContain('Bei einer Ablehnung');
      expect(prompt).toContain('die **wörtliche** Fehlermeldung');
      expect(prompt).toContain('**kein zweites\nMal** versuchen');
    });

    it.each([
      ['plan', planPrompt(7)],
      ['research', researchPrompt(7)],
    ] as const)('%s-Prompt verlangt ein Artboard je sichtbarem Zustand statt einer Sammelskizze', (_name, prompt) => {
      expect(prompt).toContain('**ein\nArtboard je sichtbarem Zustand**');
      expect(prompt).toContain('Grundzustand, Overlay/Popover/Sheet, Laden,\nFehler, leer');
      expect(prompt).toContain('nur die Zustände, die die\nEntscheidung tatsächlich braucht');
    });

    it.each([
      ['plan', planPrompt(7)],
      ['research', researchPrompt(7)],
    ] as const)('%s-Prompt sagt Backend-/Sync-/Schema-/Migrations-Tickets ausdruecklich kein Entwurfsblatt zu', (_name, prompt) => {
      expect(prompt).toContain('Reines Backend-,\nSync-, Schema- oder Migrations-Ticket: **kein** Entwurfsblatt');
    });

    it.each([
      ['plan', planPrompt(7)],
      ['research', researchPrompt(7)],
    ] as const)('%s-Prompt macht Artifact-Kommentare zum Rueckkanal, bedingt auf eine vorhandene URL', (_name, prompt) => {
      expect(prompt).toContain('Kommentare als Rückkanal');
      expect(prompt).toContain('action: "comments"');
      expect(prompt).toContain('gleichrangig mit einem Issue-Kommentar');
      expect(prompt).toContain('kein zusätzlicher Aufruf');
    });

    it.each([
      ['plan', planPrompt(7)],
      ['research', researchPrompt(7)],
    ] as const)('%s-Prompt beantwortet und loest nur freigeschaltete Threads auf', (_name, prompt) => {
      expect(prompt).toContain('action: "reply"');
      expect(prompt).toContain('action: "resolve"');
      expect(prompt).toContain('**nicht** freigeschalteten Thread liest du nur, ohne zu\nantworten oder aufzulösen');
    });
  });

  // #842: der Lauf sichert seinen Stand, BEVOR er auf Hintergrundarbeit wartet.
  // Belegt an #830: fertiger Fix, gruene Gates -- trotzdem kein Commit, weil der
  // Lauf auf einen 'test-runner'-Subagenten wartete und der Turn endete.
  describe('Sichern vor Warten (#842)', () => {
    it.each([
      ['build', buildPrompt(42)],
      ['ci-fix', ciFixPrompt(42, 'egal')],
    ] as const)('%s-Prompt verlangt Commit+Push VOR langlaufender Gegenprobe', (_name, prompt) => {
      expect(prompt).toContain('## Sichern geht vor Warten');
      expect(prompt).toContain('committet und gepusht, BEVOR');
      expect(prompt).toContain('test-runner');
    });

    it.each([
      ['build', buildPrompt(42)],
      ['ci-fix', ciFixPrompt(42, 'egal')],
    ] as const)('%s-Prompt verbietet Leerlauf-Warten und Fuellkommandos', (_name, prompt) => {
      expect(prompt).toContain('Leerlauf-Warten ist kein zulässiger Schritt');
      expect(prompt).toContain("'sleep'");
      expect(prompt).toContain('ich warte auf einen Subagenten');
    });
  });
});
