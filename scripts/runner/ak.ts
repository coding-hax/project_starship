// Akzeptanzkriterien aus dem Ticket-Body -- die eine Quelle fuer beide Seiten
// von #839: das Tor, das einen Bau-Lauf ohne AK gar nicht erst starten laesst,
// und die Rolle `check`, die den Diff gegen genau diese Liste haelt.
//
// Bewusst eine reine Funktion wie parseAfter() in queue.ts: Body rein, Liste
// raus -- kein gh, keine Uhr, kein Dateisystem. Das ist die billigste
// testbare Schicht, und beide Aufrufer sehen garantiert dieselbe Liste. Wenn
// der Pruefer eine andere Nummerierung saehe als das Tor, waere jeder Befund
// "AK 3 nicht erfuellt" eine Luege.

// Die Ueberschrift, ab der gelesen wird. Beliebige Ebene (## im Template, #
// oder ### kommen in aelteren Tickets vor), optionaler Doppelpunkt, optionale
// Singularform -- der Abschnitt heisst in ~40 offenen und geschlossenen
// Tickets dieses Repos immer 'Akzeptanzkriterien', aber die Toleranz kostet
// nichts und ein verfehlter Abschnitt kostet ein geparktes Ticket.
const HEADING = /^#{1,6}[ \t]*Akzeptanzkriteri(?:en|um)[ \t]*:?[ \t]*$/i;

// Ende des Abschnitts: die naechste Ueberschrift, egal welcher Ebene.
const ANY_HEADING = /^#{1,6}[ \t]+\S/;

// Ein Kriterium beginnt am ZEILENANFANG -- ohne Einrueckung. Zwei Formen, weil
// das Repo beide fuehrt: nummeriert ('1.' / '1)') wie in den Tickets zu #828,
// und Checkboxen ('- [ ]' / '* [x]') wie im Issue-Template
// .github/ISSUE_TEMPLATE/feature.md.
//
// Die fehlende Einrueckung ist die Abgrenzung, nicht Kosmetik: ein
// eingerueckter Aufzaehlungspunkt unter einem Kriterium ist dessen
// Fortsetzung ("AK4 ... - davon betroffen: x, y"), kein eigenes Kriterium.
// Zaehlte er mit, verschoebe sich die Nummerierung gegenueber dem, was im
// Ticket steht -- und der Befund zeigte auf das falsche Kriterium.
const ITEM = /^(?:[-*][ \t]+\[[ xX]\][ \t]*|\d+[.)][ \t]+)(.*)$/;

// Reiner Text ohne Aufzaehlung zaehlt NICHT als Kriterium (AK1 von #839). Ein
// Abschnitt "## Akzeptanzkriterien\n\nDas Ding soll schnell sein." ist keine
// Spezifikation, sondern ein Wunsch -- und genau der Fall, den das Tor fangen
// soll, statt ihn als "1 Kriterium gefunden" durchzuwinken.
export function acceptanceCriteria(body: string): string[] {
  if (!body) return [];

  const lines = body.split('\n');
  const start = lines.findIndex((line) => HEADING.test(line));
  if (start === -1) return [];

  const items: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (ANY_HEADING.test(line)) break;

    const item = ITEM.exec(line);
    if (item) {
      items.push(item[1]!.trim());
      continue;
    }

    // Fortsetzungszeile: eingerueckt oder nicht, sie gehoert zum letzten
    // Kriterium. Mehrzeilige AK sind in diesem Repo der Normalfall (die
    // Tickets brechen bei ~78 Zeichen um), ohne das Anhaengen endete jedes
    // zweite Kriterium mitten im Satz.
    if (line.trim() === '') continue;
    if (items.length > 0) items[items.length - 1] += ` ${line.trim()}`;
  }

  return items.map((text) => text.replace(/\s+/g, ' ').trim()).filter((text) => text !== '');
}

// Das Tor aus AK2 von #839 in einem Wort. Eigene Funktion statt
// `acceptanceCriteria(body).length > 0` an drei Aufrufstellen: so steht die
// Frage "darf gebaut werden?" genau einmal im Code.
export function hasAcceptanceCriteria(body: string): boolean {
  return acceptanceCriteria(body).length > 0;
}

// Der Kommentar, den das Tor ans Ticket schreibt. Hier und nicht in round.ts,
// damit der Wortlaut mitgetestet wird und nicht in einem Template-String
// zwischen zwei gh-Aufrufen verrottet.
export function missingCriteriaComment(issue: number): string {
  return `## 🚦 Kein Bau-Lauf: dem Ticket fehlen Akzeptanzkriterien

Ich habe #${issue} für einen Bau-Lauf gezogen und im Body keinen Abschnitt
\`## Akzeptanzkriterien\` mit auswertbaren Punkten gefunden. Ohne den baue ich
nicht — ohne Kriterien gibt es nichts, wogegen der fertige Diff gehalten
werden könnte, und „fertig" wäre dann meine Meinung statt deine Vorgabe.

**Was fehlt:** ein Abschnitt genau so überschrieben, darunter nummerierte
Punkte oder Checkboxen, jeder einzeln prüfbar:

\`\`\`markdown
## Akzeptanzkriterien

1. Given …, When …, Then …
2. Given ich bin offline, When ich speichere, Then erscheint es sofort und die
   Outbox enthält einen Eintrag.
\`\`\`

Fließtext ohne Aufzählung zählt nicht, eingerückte Unterpunkte zählen als
Fortsetzung des Kriteriums darüber.

Trag sie nach und nimm \`needs-answer\` ab — dann baue ich beim nächsten Takt
weiter, ohne von vorne anzufangen.`;
}
