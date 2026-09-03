import type { GoldCase } from './types';

/**
 * Kuratierte Korpusschicht: echte Sätze, Sollwert von Hand gesetzt.
 *
 * Anders als die generierte Schicht steht hier nicht die Kombinatorik im Vordergrund,
 * sondern der Einzelfall, über den man streiten kann. Wo Grammatik und diese Datei
 * streiten, gewinnt diese Datei — sie ist die Spezifikation, nicht das Protokoll.
 *
 * Die Sollwerte folgen drei Festlegungen vom 03.09.26:
 *  1. Titel wortgetreu, aber ohne Sprechrahmen, Datumsausdruck und führenden Artikel.
 *  2. Tageszeitwörter setzen feste Uhrzeiten (früh 8, vormittags 10, mittags 12,
 *     nachmittags 15, abends 19, nachts 22).
 *  3. Die Art fällt an einem Schlüsselwort (Termin/Meeting/Treffen bzw. Aufgabe/Notiz,
 *     Routine + Erledigungsverb). Eine blosse Uhrzeit macht keinen Termin.
 */

/** Lokale Zeit → ISO. Monat 1-basiert, wie man ihn spricht. */
function on(month: number, day: number, hours = 9, minutes = 0): string {
  return new Date(2024, month - 1, day, hours, minutes, 0, 0).toISOString();
}

type Row = [text: string, kind: GoldCase['expect']['kind'], title: string, dueAt: string | null];

function rows(category: string, list: Row[]): GoldCase[] {
  return list.map(([text, kind, title, dueAt], index) => ({
    id: `kur:${category.slice(0, 4).toLowerCase()}:${String(index).padStart(3, '0')}`,
    text,
    source: 'kuratiert' as const,
    category,
    expect: { kind, title, dueAt },
  }));
}

export const CURATED_CASES: GoldCase[] = [
  // Bezugspunkt überall NOW_REF: Montag, 15.01.2024, 10:00.
  ...rows('Diktiertes Kommando', [
    ['Erstell mir einen Termin für Mittwoch', 'event', 'Termin', on(1, 17)],
    ['Erstelle mir einen Termin am Mittwoch um 14 Uhr beim Zahnarzt', 'event', 'Termin Zahnarzt', on(1, 17, 14)],
    ['Mach mir einen Termin für Freitag 10 Uhr', 'event', 'Termin', on(1, 19, 10)],
    ['Leg mir eine Aufgabe an, Milch kaufen', 'task', 'Milch kaufen', null],
    ['Trag mir bitte für morgen einen Termin mit Anna ein', 'event', 'Termin mit Anna', on(1, 16)],
    ['Erinnere mich bitte morgen früh an die Rechnung', 'task', 'Rechnung', on(1, 16, 8)],
    ['Setz mir einen Termin für nächsten Dienstag um 9', 'event', 'Termin', on(1, 23, 9)],
    ['Notier dir Milch kaufen', 'task', 'Milch kaufen', null],
    ['Schreib auf, dass ich die Oma anrufen muss', 'task', 'Oma anrufen', null],
    ['Füg einen Termin hinzu, Kino am Samstag um 20 Uhr', 'event', 'Kino', on(1, 20, 20)],
    ['Neuer Termin Mittwoch 16 Uhr Teamrunde', 'event', 'Teamrunde', on(1, 17, 16)],
    ['Mach eine Notiz, dass ich das Auto tanken muss', 'task', 'Auto tanken', null],
    ['Erstell eine Aufgabe für morgen, Fenster putzen', 'task', 'Fenster putzen', on(1, 16)],
  ]),

  ...rows('Tageszeit', [
    ['Heute Abend noch die Mail an Thomas schreiben', 'task', 'Mail an Thomas schreiben', on(1, 15, 19)],
    ['Morgen früh Müll rausbringen', 'task', 'Müll rausbringen', on(1, 16, 8)],
    ['Morgen Nachmittag Oma anrufen', 'task', 'Oma anrufen', on(1, 16, 15)],
    ['Freitag abends Kino', 'task', 'Kino', on(1, 19, 19)],
    ['Übermorgen mittags Rechnung bezahlen', 'task', 'Rechnung bezahlen', on(1, 17, 12)],
    ['Abends noch die Blumen gießen', 'task', 'Blumen gießen', on(1, 15, 19)],
    // Mahlzeit verrät die Tageshälfte, bleibt aber im Titel.
    ['Am Samstag um halb acht Abendessen bei Müllers', 'task', 'Abendessen bei Müllers', on(1, 20, 19, 30)],
  ]),

  ...rows('Sprechrahmen', [
    ['Ich muss noch die Rechnung bezahlen', 'task', 'Rechnung bezahlen', null],
    ['Nicht vergessen: Blumen gießen', 'task', 'Blumen gießen', null],
    ['Erinnere mich daran den Müll rauszubringen', 'task', 'Müll rauszubringen', null],
    ['Denk dran das Auto zu tanken', 'task', 'Auto zu tanken', null],
    ['Aufgabe: Küche putzen', 'task', 'Küche putzen', null],
    ['Neue Aufgabe Fenster putzen', 'task', 'Fenster putzen', null],
    ['Ich sollte mal wieder die Fenster putzen', 'task', 'Fenster putzen', null],
    ['Bis Freitag die Präsentation fertig machen', 'task', 'Präsentation fertig machen', on(1, 19)],
  ]),

  ...rows('Schlichte Aufgabe', [
    ['Milch kaufen', 'task', 'Milch kaufen', null],
    ['Müll rausbringen', 'task', 'Müll rausbringen', null],
    ['Oma anrufen', 'task', 'Oma anrufen', null],
    ['Geschenk für Lisa besorgen', 'task', 'Geschenk für Lisa besorgen', null],
    ['Mit Max über das Projekt sprechen', 'task', 'Mit Max über das Projekt sprechen', null],
    ['Bei Rewe einkaufen', 'task', 'Bei Rewe einkaufen', null],
    // Zahlwörter im Titel dürfen nicht als Uhrzeit gelesen werden.
    ['Vier Bier kaufen', 'task', 'Vier Bier kaufen', null],
    ['Acht Eier kaufen', 'task', 'Acht Eier kaufen', null],
    ['Zwei Kisten Wasser holen', 'task', 'Zwei Kisten Wasser holen', null],
    ['Viertel Sahne besorgen', 'task', 'Viertel Sahne besorgen', null],
  ]),

  ...rows('Uhrzeit ohne Termin', [
    // Entscheidung 3: eine Uhrzeit allein macht keinen Kalendertermin.
    ['Um 8 Brötchen holen', 'task', 'Brötchen holen', on(1, 16, 8)],
    ['Morgen um 14 Uhr Milch kaufen', 'task', 'Milch kaufen', on(1, 16, 14)],
    ['Zug nach Hamburg um 7:42', 'task', 'Zug nach Hamburg', on(1, 16, 7, 42)],
  ]),

  ...rows('Termin per Schlüsselwort', [
    ['Meeting mit dem Team um 14 Uhr', 'event', 'Meeting mit dem Team', on(1, 15, 14)],
    ['Termin beim Friseur', 'event', 'Termin beim Friseur', null],
    ['Treffen mit Jonas am Donnerstag', 'event', 'Treffen mit Jonas', on(1, 18)],
  ]),
];
