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
 *  4. Nachtrag: der Titel wird auf die Grundform zurückgebaut. zu-Infinitiv auflösen
 *     („rauszubringen" → „rausbringen"), Satzkopf und Richtungspräposition streichen
 *     („kommt der Handwerker" → „Handwerker", „zum Zahnarzt" → „Zahnarzt"),
 *     Verb-Pronomen-Inversion umstellen („ruf ich Oma an" → „Oma anrufen"). Der erste
 *     Buchstabe wird nur gross, wenn tatsächlich umgebaut oder ein Sprechrahmen
 *     entfernt wurde — nach einer blossen Zeitangabe bleibt die Schreibweise des
 *     Nutzers („in einer Woche nachfassen" → „nachfassen"). Alles über geschlossene
 *     Wortlisten; die Fälle unter „Rückbau darf nicht zuschlagen" halten die Grenze.
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
    ['Erstelle mir einen Termin am Mittwoch um 14 Uhr beim Zahnarzt', 'event', 'Termin Zahnarzt', on(1, 17, 14)],
    ['Termin für Mittwoch anlegen', 'event', 'Termin', on(1, 17)],
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
    // zu-Infinitiv wird zurückgebaut (Entscheidung 03.09.26, zweite Runde).
    ['Erinnere mich daran den Müll rauszubringen', 'task', 'Müll rausbringen', null],
    ['Denk dran das Auto zu tanken', 'task', 'Auto tanken', null],
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

  ...rows('Gesprochen — Kommando', [
    ['Mach mir ne Notiz: Reifen wechseln', 'task', 'Reifen wechseln', null],
    ['Setz mir das mal auf die Liste: Fenster putzen', 'task', 'Fenster putzen', null],
    ['Pack Milch auf meine Liste', 'task', 'Milch', null],
    ['Schreib mir auf, dass ich tanken muss', 'task', 'Tanken', null],
    ['Trag das mal für Donnerstag ein', 'task', '', on(1, 18)],
    ['Kannst du das für Dienstag eintragen, Zahnarzt', 'task', 'Zahnarzt', on(1, 16)],
    ['Kannst du mir morgen um 9 einen Termin machen', 'event', 'Termin machen', on(1, 16, 9)],
    ['Könntest du mir bitte für morgen einen Termin anlegen', 'event', 'Termin', on(1, 16)],
    ['Wär super wenn du Milch kaufen notierst', 'task', 'Milch kaufen', null],
    ['Gib mir für morgen eine Erinnerung: Rechnung bezahlen', 'task', 'Rechnung bezahlen', on(1, 16)],
    ['Erinner mich morgen an die Rechnung', 'task', 'Rechnung', on(1, 16)],
    ['Ich brauch am Freitag einen Termin beim Friseur', 'event', 'Termin beim Friseur', on(1, 19)],
    ['Ich hab morgen um 10 einen Termin', 'event', 'Termin', on(1, 16, 10)],
  ]),

  ...rows('Gesprochen — Zögern', [
    ['Also ähm, Milch kaufen', 'task', 'Milch kaufen', null],
    ['Ja also ich müsste noch die Rechnung bezahlen', 'task', 'Rechnung bezahlen', null],
    ['Äh, morgen Müll rausbringen', 'task', 'Müll rausbringen', on(1, 16)],
    ['Naja, Fenster putzen', 'task', 'Fenster putzen', null],
    ['Übrigens, Oma anrufen', 'task', 'Oma anrufen', null],
  ]),

  ...rows('Gesprochen — Telegrammstil', [
    // Der Bezugspunkt ist ein Montag, „Mo" meint deshalb heute.
    ['Mo 14 Uhr Zahnarzt', 'task', 'Zahnarzt', on(1, 15, 14)],
    ['Di früh Sport', 'task', 'Sport', on(1, 16, 8)],
    ['Fr 19h Kino', 'task', 'Kino', on(1, 19, 19)],
    ['morgen 8h Standup', 'task', 'Standup', on(1, 16, 8)],
    ['Mi. Handwerker', 'task', 'Handwerker', on(1, 17)],
    ['Do 16:30 Teamrunde', 'task', 'Teamrunde', on(1, 18, 16, 30)],
    // „24h" ist eine Öffnungszeit, keine Uhrzeit.
    ['24h Service anrufen', 'task', '24h Service anrufen', null],
  ]),

  ...rows('Gesprochen — Routine erledigt', [
    ['Hab heute schon Sport gemacht', 'habit_check', 'Hab schon Sport gemacht', null],
    ['Sport ist erledigt für heute', 'habit_check', 'Sport ist erledigt', null],
    ['Yoga hab ich heute schon', 'habit_check', 'Yoga hab ich schon', null],
    ['Lesen kann ich abhaken', 'habit_check', 'Lesen kann ich abhaken', null],
  ]),

  ...rows('Gesprochen — Verb vor dem Titel', [
    // Zurückgebaut (Entscheidung 03.09.26, zweite Runde): der Satzkopf fällt, die
    // Richtungspräposition fällt, die Verb-Pronomen-Inversion wird zur Grundform
    // umgestellt. Vorher stand hier „kommt der Handwerker" und „zum Zahnarzt".
    ['Ich muss morgen zum Zahnarzt', 'task', 'Zahnarzt', on(1, 16)],
    ['Ich muss zur Post', 'task', 'Post', null],
    ['Ich fahr morgen nach Hamburg', 'task', 'Hamburg', on(1, 16)],
    ['Ich hab am Freitag frei', 'task', 'Frei', on(1, 19)],
    ['Am Mittwoch kommt der Handwerker', 'task', 'Handwerker', on(1, 17)],
    ['Nächsten Montag ist Elternabend', 'task', 'Elternabend', on(1, 22)],
    ['Am Montag beginnt der Kurs', 'task', 'Kurs', on(1, 15)],
    ['Übermorgen ist Abgabe', 'task', 'Abgabe', on(1, 17)],
    ['Freitag treff ich Anna', 'task', 'Anna treffen', on(1, 19)],
    ['Freitag ruf ich Oma an', 'task', 'Oma anrufen', on(1, 19)],
    ['Morgen hol ich das Paket', 'task', 'Paket holen', on(1, 16)],
    ['Samstag geh ich ins Kino', 'task', 'Kino gehen', on(1, 20)],
    ['Ich geh morgen um 7 laufen', 'task', 'Laufen', on(1, 16, 7)],
    ['Wir essen Samstag um 19 Uhr bei Müllers', 'task', 'Essen bei Müllers', on(1, 20, 19)],
    ['Milch kaufen und Brot holen', 'task', 'Milch kaufen und Brot holen', null],
    ['Morgen: Zahnarzt um 10, danach einkaufen', 'task', 'Zahnarzt, danach einkaufen', on(1, 16, 10)],
  ]),

  ...rows('Rückbau darf nicht zuschlagen', [
    // Sätze, die nur so aussehen. „Mit"/„Bei"/„Für" sind keine Richtungspräpositionen,
    // „Ist-Zustand" ist kein Satzkopf, und „zu Weihnachten" ist kein zu-Infinitiv.
    ['Mit Max über das Projekt sprechen', 'task', 'Mit Max über das Projekt sprechen', null],
    ['Bei Rewe einkaufen', 'task', 'Bei Rewe einkaufen', null],
    ['Ist-Zustand dokumentieren', 'task', 'Ist-Zustand dokumentieren', null],
    ['Geschenk zu Weihnachten besorgen', 'task', 'Geschenk zu Weihnachten besorgen', null],
    ['Zusammenfassung schreiben', 'task', 'Zusammenfassung schreiben', null],
    ['Istanbul Reise planen', 'task', 'Istanbul Reise planen', null],
    ['Kommt-Zeit-Plakat aufhängen', 'task', 'Kommt-Zeit-Plakat aufhängen', null],
    ['Geht klar Notiz', 'task', 'Geht klar Notiz', null],
    ['Hausaufgaben machen', 'task', 'Hausaufgaben machen', null],
  ]),

  ...rows('Schwierige Konstruktion', [
    // Zeitspanne: ein Termin, zwei genannte Uhrzeiten — gemeint ist der Anfang.
    ['Meeting morgen von 10 bis 12', 'event', 'Meeting', on(1, 16, 10)],
    ['Termin am Freitag zwischen 14 und 16 Uhr', 'event', 'Termin', on(1, 19, 14)],
    ['Urlaub vom 3. bis 10. März', 'task', 'Urlaub', on(3, 3)],
    ['Workshop Montag 9-17 Uhr', 'task', 'Workshop', on(1, 15, 9)],
    ['Sprechstunde morgen 8 bis 10 Uhr', 'task', 'Sprechstunde', on(1, 16, 8)],
    ['Konferenz vom 5. bis 7. Juni', 'task', 'Konferenz', on(6, 5)],
    // Wiederholung vor dem Titel — der Ausdruck darf ihn nicht zerreissen.
    ['Jeden Montag Müll rausbringen', 'task', 'Müll rausbringen', on(1, 15)],
    ['Jede Woche Rechnungen prüfen', 'task', 'Rechnungen prüfen', null],
    ['Alle zwei Wochen Rasen mähen', 'task', 'Rasen mähen', null],
    ['Täglich Vitamine nehmen', 'task', 'Vitamine nehmen', null],
    ['Jeden zweiten Montag Team-Call', 'task', 'Team-Call', on(1, 15)],
    // Viele Angaben, aber nur ein Termin — lief schon vorher.
    ['Am Freitag um 15 Uhr Termin mit Frau Berger im Büro wegen des Vertrags', 'event',
      'Termin mit Frau Berger im Büro wegen des Vertrags', on(1, 19, 15)],
    ['Nächsten Dienstag 14 Uhr Elternabend in der Schule von Lisa', 'task',
      'Elternabend in der Schule von Lisa', on(1, 23, 14)],
    // Nebensätze bleiben vollständig im Titel.
    ['Den Bericht lesen, den Anna geschickt hat', 'task', 'Bericht lesen, den Anna geschickt hat', null],
    ['Wenn das Paket kommt, Anna Bescheid geben', 'task', 'Wenn das Paket kommt, Anna Bescheid geben', null],
  ]),

  ...rows('Wiederholung nur zufällig vorn', [
    // Kein Wiederholungsausdruck, obwohl das erste Wort so aussieht.
    ['Jede Menge Arbeit', 'task', 'Jede Menge Arbeit', null],
    ['Alle Unterlagen sortieren', 'task', 'Alle Unterlagen sortieren', null],
    ['Freitagsbrötchen bestellen', 'task', 'Freitagsbrötchen bestellen', null],
    ['Wochenbericht schreiben', 'task', 'Wochenbericht schreiben', null],
    ['Tagesordnung erstellen', 'task', 'Tagesordnung erstellen', null],
    ['Von Hand nacharbeiten', 'task', 'Von Hand nacharbeiten', null],
  ]),

  ...rows('Rahmenwort nur zufällig vorn', [
    // Titel, die mit einem Rahmen- oder Diktierwort beginnen, dürfen nicht beschnitten
    // werden. „ja" und „ok" brauchen dafür eine strengere Grenze als \b — die steht
    // auch vor einem Bindestrich.
    ['Ja-Sager Buch zurückgeben', 'task', 'Ja-Sager Buch zurückgeben', null],
    ['Ok-Zeichen entwerfen', 'task', 'Ok-Zeichen entwerfen', null],
    ['Also-Konzept lesen', 'task', 'Also-Konzept lesen', null],
    ['Jalousie reparieren', 'task', 'Jalousie reparieren', null],
    ['Achse prüfen lassen', 'task', 'Achse prüfen lassen', null],
    ['Wichtiger Anruf bei Peter', 'task', 'Wichtiger Anruf bei Peter', null],
    ['Moment abwarten', 'task', 'Moment abwarten', null],
    ['Diplomarbeit abgeben', 'task', 'Diplomarbeit abgeben', null],
    ['Dokumente sortieren', 'task', 'Dokumente sortieren', null],
    ['Sofa bestellen', 'task', 'Sofa bestellen', null],
    ['Merkzettel schreiben', 'task', 'Merkzettel schreiben', null],
    ['Listenpreis prüfen', 'task', 'Listenpreis prüfen', null],
  ]),

  ...rows('Kein Diktat, nur ein Verb', [
    // Das erste Wort ist zufällig auch ein Diktierverb. Ohne zweites Signal
    // (Dativpronomen, „bitte", Objektwort, Trenner) bleibt der Satz unangetastet —
    // sonst würde aus „Plan B besprechen" ein „B besprechen".
    ['Plan B besprechen', 'task', 'Plan B besprechen', null],
    ['Leg dich hin', 'task', 'Leg dich hin', null],
    ['Setz Kaffee auf', 'task', 'Setz Kaffee auf', null],
    ['Pack Koffer', 'task', 'Pack Koffer', null],
    ['Notiere Kilometerstand', 'task', 'Notiere Kilometerstand', null],
    ['Schreib Oma eine Mail', 'task', 'Schreib Oma eine Mail', null],
    ['Mach Sport', 'task', 'Mach Sport', null],
    ['Planung fertigstellen', 'task', 'Planung fertigstellen', null],
  ]),

  ...rows('Schlüsselwort-Grenzfall', [
    // Offen: hier plant man den Termin, man hat ihn nicht. Nach der Regel vom 03.09.26
    // („Schlüsselwort muss gesagt werden") ist es trotzdem ein Termin. Eine Ausnahme für
    // „Termin … vereinbaren/absagen/verschieben" wäre semantisch richtiger, ist aber
    // nicht entschieden — deshalb steht hier das regelkonforme Ergebnis.
    ['Zahnarzttermin vereinbaren', 'event', 'Zahnarzttermin vereinbaren', null],
    ['Termin beim Amt vereinbaren', 'event', 'Termin beim Amt vereinbaren', null],
    ['Termin am Freitag absagen', 'event', 'Termin absagen', on(1, 19)],
  ]),

  ...rows('Termin per Schlüsselwort', [
    ['Meeting mit dem Team um 14 Uhr', 'event', 'Meeting mit dem Team', on(1, 15, 14)],
    ['Termin beim Friseur', 'event', 'Termin beim Friseur', null],
    ['Treffen mit Jonas am Donnerstag', 'event', 'Treffen mit Jonas', on(1, 18)],
  ]),
];
