import { describe, expect, it } from 'vitest';
import { parseTaskInput } from './parse-task-input';

// Fixed reference point: Montag, 15.01.2024, 10:00 lokal — independent of the day the
// test suite actually runs on (AC6).
const NOW = new Date(2024, 0, 15, 10, 0, 0);

function iso(year: number, month: number, day: number, hours = 9, minutes = 0): string {
  return new Date(year, month - 1, day, hours, minutes, 0, 0).toISOString();
}

describe('parseTaskInput', () => {
  it('erkennt "heute" und setzt die Default-Uhrzeit 09:00', () => {
    const result = parseTaskInput('Blumen gießen heute', NOW);
    expect(result.title).toBe('Blumen gießen');
    expect(result.dueAt).toBe(iso(2024, 1, 15));
  });

  it('erkennt "morgen"', () => {
    const result = parseTaskInput('Arzt anrufen morgen', NOW);
    expect(result.title).toBe('Arzt anrufen');
    expect(result.dueAt).toBe(iso(2024, 1, 16));
  });

  it('erkennt "übermorgen"', () => {
    const result = parseTaskInput('Paket abholen übermorgen', NOW);
    expect(result.title).toBe('Paket abholen');
    expect(result.dueAt).toBe(iso(2024, 1, 17));
  });

  it('löst einen Wochentag auf das nächste zukünftige Vorkommen auf', () => {
    // NOW ist Montag -> "mittwoch" ist zwei Tage später.
    const result = parseTaskInput('Müll rausbringen mittwoch', NOW);
    expect(result.title).toBe('Müll rausbringen');
    expect(result.dueAt).toBe(iso(2024, 1, 17));
  });

  it('ein Wochentag, der auf heute fällt, zählt als heute', () => {
    const result = parseTaskInput('Sport machen montag', NOW);
    expect(result.title).toBe('Sport machen');
    expect(result.dueAt).toBe(iso(2024, 1, 15));
  });

  it('erkennt "um H"', () => {
    const result = parseTaskInput('Arzt anrufen morgen um 12', NOW);
    expect(result.title).toBe('Arzt anrufen');
    expect(result.dueAt).toBe(iso(2024, 1, 16, 12, 0));
  });

  it('erkennt "H Uhr"', () => {
    const result = parseTaskInput('Zahnarzt heute 12 Uhr', NOW);
    expect(result.title).toBe('Zahnarzt');
    expect(result.dueAt).toBe(iso(2024, 1, 15, 12, 0));
  });

  it('erkennt "HH:MM"', () => {
    const result = parseTaskInput('Übergabe morgen 14:30', NOW);
    expect(result.title).toBe('Übergabe');
    expect(result.dueAt).toBe(iso(2024, 1, 16, 14, 30));
  });

  it('erkennt ein absolutes Datum "am D.M." im laufenden Jahr', () => {
    const result = parseTaskInput('Steuererklärung am 4.8.', NOW);
    expect(result.title).toBe('Steuererklärung');
    expect(result.dueAt).toBe(iso(2024, 8, 4));
  });

  it('ein absolutes Datum in der Vergangenheit springt ins nächste Jahr', () => {
    const result = parseTaskInput('Jahresrückblick am 1.1.', NOW);
    expect(result.title).toBe('Jahresrückblick');
    expect(result.dueAt).toBe(iso(2025, 1, 1));
  });

  it('ohne erkanntes Datum bleibt dueAt null und der Titel unverändert', () => {
    const result = parseTaskInput('Milch kaufen', NOW);
    expect(result.title).toBe('Milch kaufen');
    expect(result.dueAt).toBeNull();
  });

  it('entfernt Aktions-/Füllwörter aus dem Titel', () => {
    const result = parseTaskInput('erstelle neue aufgabe Wäsche aufhängen', NOW);
    expect(result.title).toBe('Wäsche aufhängen');
    expect(result.dueAt).toBeNull();
  });

  it('AC5 (#687): bleibt nach dem Entfernen aller Spans kein Titel übrig, bleibt er leer — die Fälligkeit bleibt erhalten, keine Rohzeile mehr als Fallback', () => {
    const result = parseTaskInput('morgen um 12', NOW);
    expect(result.title).toBe('');
    expect(result.dueAt).toBe(iso(2024, 1, 16, 12, 0));
  });

  it('AC7: iOS-Auto-Satzzeichen am Rand hinterlassen keinen Müll im Titel', () => {
    const result = parseTaskInput('Zahnarzt morgen um 12.', NOW);
    expect(result.title).toBe('Zahnarzt');
    expect(result.dueAt).toBe(iso(2024, 1, 16, 12, 0));
  });

  it('AC7: iOS-Auto-Satzzeichen nach einem Komma hinterlassen keinen Müll im Titel', () => {
    const result = parseTaskInput('Erinnere mich an Zahnarzt, morgen um 12.', NOW);
    expect(result.title).toBe('Zahnarzt');
    expect(result.dueAt).toBe(iso(2024, 1, 16, 12, 0));
  });

  it('AC7: interne Kommata im Titel bleiben erhalten', () => {
    const result = parseTaskInput('Milch, Eier kaufen heute', NOW);
    expect(result.title).toBe('Milch, Eier kaufen');
    expect(result.dueAt).toBe(iso(2024, 1, 15));
  });

  it('AC8: erkennt ausgeschriebene Uhrzeit "um zwölf"', () => {
    const result = parseTaskInput('Zahnarzt morgen um zwölf', NOW);
    expect(result.title).toBe('Zahnarzt');
    expect(result.dueAt).toBe(iso(2024, 1, 16, 12, 0));
  });

  it('AC8: erkennt ausgeschriebene Uhrzeit "<Zahl> Uhr"', () => {
    const result = parseTaskInput('Zahnarzt heute drei Uhr', NOW);
    expect(result.title).toBe('Zahnarzt');
    expect(result.dueAt).toBe(iso(2024, 1, 15, 3, 0));
  });

  it('AC8: ausgeschriebene Uhrzeiten über zwölf fallen weiterhin auf 09:00 (dokumentierte Grenze)', () => {
    const result = parseTaskInput('Zahnarzt morgen um vierzehn', NOW);
    expect(result.dueAt).toBe(iso(2024, 1, 16, 9, 0));
  });
});

describe('parseTaskInput — #687 AK1: Schreibweise der Uhrzeit ändert das Ergebnis nicht', () => {
  it('"um H Uhr" ist ein Span, kein "Uhr bleibt im Titel"-Rest (der ursprüngliche Bug)', () => {
    const result = parseTaskInput('morgen um 14 Uhr Zahnarzt', NOW);
    expect(result.title).toBe('Zahnarzt');
    expect(result.dueAt).toBe(iso(2024, 1, 16, 14, 0));
  });

  it('"um H:MM Uhr" ist ebenfalls ein einziger, längster Span', () => {
    const result = parseTaskInput('morgen um 14:30 Uhr Zahnarzt', NOW);
    expect(result.title).toBe('Zahnarzt');
    expect(result.dueAt).toBe(iso(2024, 1, 16, 14, 30));
  });

  it('"H Uhr" ohne "um" liefert dasselbe Ergebnis', () => {
    const result = parseTaskInput('morgen 14 Uhr Zahnarzt', NOW);
    expect(result.title).toBe('Zahnarzt');
    expect(result.dueAt).toBe(iso(2024, 1, 16, 14, 0));
  });

  it('"um H" ohne "Uhr" liefert dasselbe Ergebnis', () => {
    const result = parseTaskInput('morgen um 14 Zahnarzt', NOW);
    expect(result.title).toBe('Zahnarzt');
    expect(result.dueAt).toBe(iso(2024, 1, 16, 14, 0));
  });
});

describe('parseTaskInput — #687 AK2: Uhrzeit ohne Datum wird ausgewertet', () => {
  it('liegt die Uhrzeit noch in der Zukunft, gilt sie für heute', () => {
    // NOW = Mo 15.01.2024 10:00 -> 15 Uhr ist noch nicht vorbei.
    const result = parseTaskInput('Zahnarzt um 15 Uhr', NOW);
    expect(result.title).toBe('Zahnarzt');
    expect(result.dueAt).toBe(iso(2024, 1, 15, 15, 0));
  });

  it('liegt die Uhrzeit bereits in der Vergangenheit, gilt sie für morgen', () => {
    const result = parseTaskInput('Zahnarzt um 9 Uhr', NOW);
    expect(result.title).toBe('Zahnarzt');
    expect(result.dueAt).toBe(iso(2024, 1, 16, 9, 0));
  });
});

describe('parseTaskInput — #687 AK3: Titel ist der Rest, nicht das Ergebnis einer Blacklist', () => {
  it('"erste Aufgabe erledigen" bleibt unverändert — kein Span trifft', () => {
    expect(parseTaskInput('erste Aufgabe erledigen', NOW).title).toBe('erste Aufgabe erledigen');
  });

  it('"Aufgabenliste sortieren" bleibt unverändert — "aufgabe" ist Teil eines längeren Worts', () => {
    expect(parseTaskInput('Aufgabenliste sortieren', NOW).title).toBe('Aufgabenliste sortieren');
  });

  it('führendes "Mit" steht an keiner Span-Grenze und bleibt stehen', () => {
    const result = parseTaskInput('Mit dem Auto morgen zur Werkstatt', NOW);
    expect(result.title).toBe('Mit dem Auto zur Werkstatt');
    expect(result.dueAt).toBe(iso(2024, 1, 16));
  });

  it('"am"/"um" fallen als Bindewörter an der Span-Grenze, "in der Klinik" bleibt', () => {
    const result = parseTaskInput('Zahnarzt am Dienstag um 12 in der Klinik', NOW);
    expect(result.title).toBe('Zahnarzt in der Klinik');
    expect(result.dueAt).toBe(iso(2024, 1, 16, 12, 0));
  });

  it('"bei Dr." ist keines der Bindewörter und bleibt im Titel', () => {
    const result = parseTaskInput('Anruf bei Dr. Meier morgen 9 Uhr', NOW);
    expect(result.title).toBe('Anruf bei Dr. Meier');
    expect(result.dueAt).toBe(iso(2024, 1, 16, 9, 0));
  });

  it('"Termin"/"Aufgabe" mitten im Satz bleiben stehen, keine Wort-Blacklist mehr', () => {
    const result = parseTaskInput('morgen 14 Uhr Termin mit Termin-Chef besprechen', NOW);
    expect(result.title).toBe('Termin mit Termin-Chef besprechen');
    expect(result.dueAt).toBe(iso(2024, 1, 16, 14, 0));
  });
});

describe('parseTaskInput — #687 AK4: Kommandopräfixe fallen, Inhalt bleibt', () => {
  it('"neue Aufgabe:" fällt komplett samt Doppelpunkt', () => {
    const result = parseTaskInput('neue Aufgabe: Küche putzen', NOW);
    expect(result.title).toBe('Küche putzen');
    expect(result.dueAt).toBeNull();
  });

  it('"bitte" am Satzanfang fällt, das restliche Datum/Zeit bleibt erhalten', () => {
    const result = parseTaskInput('bitte morgen um 9 Anna anrufen', NOW);
    expect(result.title).toBe('Anna anrufen');
    expect(result.dueAt).toBe(iso(2024, 1, 16, 9, 0));
  });

  it('"erinnere mich" fällt, "daran" fällt als Bindewort direkt nach dem Datum-Span', () => {
    const result = parseTaskInput('erinnere mich morgen daran, den Müll rauszubringen', NOW);
    expect(result.title).toBe('den Müll rauszubringen');
    expect(result.dueAt).toBe(iso(2024, 1, 16));
  });

  it('"Termin" fällt, wenn unmittelbar (auch über Satzzeichen hinweg) ein Datum-Span folgt', () => {
    const result = parseTaskInput('Termin, morgen, 14 Uhr, Zahnarzt.', NOW);
    expect(result.title).toBe('Zahnarzt');
    expect(result.dueAt).toBe(iso(2024, 1, 16, 14, 0));
  });

  it('"Termin" + Datum direkt gefolgt, "beim" fällt nach dem Zeit-Span', () => {
    const result = parseTaskInput('Termin morgen um 12 beim Zahnarzt', NOW);
    expect(result.title).toBe('Zahnarzt');
    expect(result.dueAt).toBe(iso(2024, 1, 16, 12, 0));
  });

  it('"Titel X" ist eine explizite Titelangabe und schlägt alles andere', () => {
    const result = parseTaskInput('erstelle einen Termin für morgen um 12, Titel Doktor', NOW);
    expect(result.title).toBe('Doktor');
    expect(result.dueAt).toBe(iso(2024, 1, 16, 12, 0));
  });
});

describe('parseTaskInput — #688 R1: Zeigerzeit', () => {
  it('"halb H": "halb zwölf" ist 11:30, nicht 12:30 — der klassische Fehler', () => {
    const result = parseTaskInput('morgen halb zwölf Zahnarzt', NOW);
    expect(result.title).toBe('Zahnarzt');
    expect(result.dueAt).toBe(iso(2024, 1, 16, 11, 30));
  });

  it('"halb H" als Ziffer, "um" fällt als Bindewort — dasselbe Ergebnis wie das Wort', () => {
    const result = parseTaskInput('morgen um halb 12 Zahnarzt', NOW);
    expect(result.title).toBe('Zahnarzt');
    expect(result.dueAt).toBe(iso(2024, 1, 16, 11, 30));
  });

  it('"viertel nach H"', () => {
    const result = parseTaskInput('morgen viertel nach acht Frühstück', NOW);
    expect(result.title).toBe('Frühstück');
    expect(result.dueAt).toBe(iso(2024, 1, 16, 8, 15));
  });

  it('"viertel vor H" — die genannte Stunde (neun) entscheidet die Tageshälfte, nicht die aufgelöste (acht)', () => {
    const result = parseTaskInput('morgen viertel vor neun Zahnarzt', NOW);
    expect(result.title).toBe('Zahnarzt');
    expect(result.dueAt).toBe(iso(2024, 1, 16, 8, 45));
  });

  it('"M vor halb H": "fünf vor halb drei"', () => {
    const result = parseTaskInput('morgen fünf vor halb drei Call', NOW);
    expect(result.title).toBe('Call');
    expect(result.dueAt).toBe(iso(2024, 1, 16, 2, 25));
  });

  it('"M nach halb H": "zehn nach halb drei"', () => {
    const result = parseTaskInput('morgen zehn nach halb drei Call', NOW);
    expect(result.title).toBe('Call');
    expect(result.dueAt).toBe(iso(2024, 1, 16, 2, 40));
  });

  it('regionale Kurzform "dreiviertel H" ohne vor/nach', () => {
    const result = parseTaskInput('morgen dreiviertel zwölf Abgabe', NOW);
    expect(result.title).toBe('Abgabe');
    expect(result.dueAt).toBe(iso(2024, 1, 16, 11, 45));
  });

  it('regionale Kurzform "viertel H" ohne vor/nach — nicht zu verwechseln mit "viertel nach H"', () => {
    const result = parseTaskInput('morgen viertel zwölf Abgabe', NOW);
    expect(result.title).toBe('Abgabe');
    expect(result.dueAt).toBe(iso(2024, 1, 16, 11, 15));
  });
});

describe('parseTaskInput — #688 R2: Tageshälften', () => {
  it('ohne Tageszeitwort entscheidet der Sprechzeitpunkt: vor 12:00 gesprochen -> vormittags', () => {
    const result = parseTaskInput('morgen um 8 Standup', NOW);
    expect(result.title).toBe('Standup');
    expect(result.dueAt).toBe(iso(2024, 1, 16, 8, 0));
  });

  it('derselbe Satz ab 12:00 gesprochen -> nachmittags', () => {
    const afternoon = new Date(2024, 0, 15, 15, 0, 0);
    const result = parseTaskInput('morgen um 8 Standup', afternoon);
    expect(result.dueAt).toBe(iso(2024, 1, 16, 20, 0));
  });

  it('ein Tageszeitwort schlägt die Heuristik, Ziffer + "Uhr"', () => {
    const result = parseTaskInput('morgen um 8 abends Kino', NOW);
    expect(result.title).toBe('Kino');
    expect(result.dueAt).toBe(iso(2024, 1, 16, 20, 0));
  });

  it('ein Tageszeitwort schlägt die Heuristik, Zahlwort statt Ziffer, entfernt aus dem Titel', () => {
    const result = parseTaskInput('morgen um drei nachmittags Kaffee', NOW);
    expect(result.title).toBe('Kaffee');
    expect(result.dueAt).toBe(iso(2024, 1, 16, 15, 0));
  });

  it('"morgens" bestätigt lediglich die Heuristik (schon vormittags gesprochen)', () => {
    const result = parseTaskInput('morgen um 6 Uhr morgens Sport', NOW);
    expect(result.title).toBe('Sport');
    expect(result.dueAt).toBe(iso(2024, 1, 16, 6, 0));
  });

  it('eine Doppelpunkt-Uhrzeit ist immer ausgeschrieben, nie mehrdeutig', () => {
    const result = parseTaskInput('morgen 0:30 Nachtschicht', NOW);
    expect(result.title).toBe('Nachtschicht');
    expect(result.dueAt).toBe(iso(2024, 1, 16, 0, 30));
  });
});

describe('parseTaskInput — #688 needsConfirmation', () => {
  it('bleibt false ohne erkannte Uhrzeit', () => {
    expect(parseTaskInput('Milch kaufen', NOW).needsConfirmation).toBe(false);
  });

  it('eine geratene Zeit außerhalb des Nachtfensters bleibt false', () => {
    expect(parseTaskInput('morgen um 6 Sport', NOW).needsConfirmation).toBe(false);
  });

  it('eine ausgeschriebene Nachtzeit (Doppelpunkt) ist nie geraten -> false, obwohl sie im Fenster liegt', () => {
    expect(parseTaskInput('morgen 0:30 Nachtschicht', NOW).needsConfirmation).toBe(false);
  });

  it('ein Tageszeitwort macht eine Zeit nicht mehr "geraten" -> false, auch im Fenster', () => {
    expect(parseTaskInput('morgen um 2 nachts Nachtschicht', NOW).needsConfirmation).toBe(false);
  });

  it('eine geratene Zeit im Nachtfenster (00:00-05:59) -> true', () => {
    expect(parseTaskInput('morgen halb eins Mittagessen', NOW).needsConfirmation).toBe(true);
  });

  it('eine regionale Kurzform -> true, unabhängig vom Nachtfenster', () => {
    const result = parseTaskInput('morgen dreiviertel zwölf Abgabe', NOW);
    expect(result.dueAt).toBe(iso(2024, 1, 16, 11, 45)); // außerhalb des Nachtfensters
    expect(result.needsConfirmation).toBe(true);
  });
});

describe('parseTaskInput — #689 AK1: Monatsnamen und ungültige Daten', () => {
  it('erkennt "D. Monatsname" ohne Jahr im laufenden Jahr', () => {
    const result = parseTaskInput('am 4. August Zahnarzt', NOW);
    expect(result.title).toBe('Zahnarzt');
    expect(result.dueAt).toBe(iso(2024, 8, 4));
  });

  it('ein kalendarisch ungültiges Datum wird verworfen, nie auf den Folgemonat gerollt', () => {
    const result = parseTaskInput('am 31.6. Termin', NOW);
    expect(result.title).toBe('am 31.6. Termin');
    expect(result.dueAt).toBeNull();
  });
});

describe('parseTaskInput — #689 AK2: relative Spannen', () => {
  it('"in drei Tagen"', () => {
    const result = parseTaskInput('in drei Tagen Rechnung zahlen', NOW);
    expect(result.title).toBe('Rechnung zahlen');
    expect(result.dueAt).toBe(iso(2024, 1, 18));
  });

  it('"in einer Woche"', () => {
    const result = parseTaskInput('in einer Woche nachfassen', NOW);
    expect(result.title).toBe('nachfassen');
    expect(result.dueAt).toBe(iso(2024, 1, 22));
  });
});

describe('parseTaskInput — #689 AK3: "nächsten" überspringt eine Woche', () => {
  it('die bloße Wochentagsform bleibt unverändert (Kontrolle)', () => {
    const result = parseTaskInput('Dienstag Steuer machen', NOW);
    expect(result.title).toBe('Steuer machen');
    expect(result.dueAt).toBe(iso(2024, 1, 16));
  });

  it('"nächsten Dienstag" überspringt eine ganze Woche', () => {
    const result = parseTaskInput('nächsten Dienstag Zahnarzt', NOW);
    expect(result.title).toBe('Zahnarzt');
    expect(result.dueAt).toBe(iso(2024, 1, 23));
  });

  it('"diesen" ist ein Synonym der bloßen Wochentagsform', () => {
    const result = parseTaskInput('diesen Mittwoch Werkstatt', NOW);
    expect(result.title).toBe('Werkstatt');
    expect(result.dueAt).toBe(iso(2024, 1, 17));
  });

  it('"kommenden" ist ein Synonym der bloßen Wochentagsform', () => {
    const result = parseTaskInput('kommenden Samstag wandern', NOW);
    expect(result.title).toBe('wandern');
    expect(result.dueAt).toBe(iso(2024, 1, 20));
  });
});

describe('parseTaskInput — #689 AK4: der Satz aus #620 fällt lokal', () => {
  it('"kannst du mir für nächsten Dienstag viertel vor neun einen Zahnarzttermin einstellen"', () => {
    const result = parseTaskInput(
      'kannst du mir für nächsten Dienstag viertel vor neun einen Zahnarzttermin einstellen',
      NOW,
    );
    expect(result.title).toBe('Zahnarzttermin');
    expect(result.dueAt).toBe(iso(2024, 1, 23, 8, 45));
  });
});

describe('parseTaskInput — #689 AK5: Tagesgrenze 04:00', () => {
  // Dienstag, 16.01.2024, 01:30 — logischer Tag ist noch Montag 15.01. (Bezugspunkt AK5).
  const NIGHT = new Date(2024, 0, 16, 1, 30, 0);

  it('"morgen 14 Uhr" bleibt derselbe reale Kalendertag', () => {
    expect(parseTaskInput('morgen 14 Uhr Zahnarzt', NIGHT).dueAt).toBe(iso(2024, 1, 16, 14, 0));
  });

  it('"heute noch" ist der logische Tag (Montag), nicht der reale (Dienstag)', () => {
    expect(parseTaskInput('heute noch Müll rausbringen', NIGHT).dueAt).toBe(iso(2024, 1, 15));
  });

  it('"übermorgen" zählt ab dem logischen Tag', () => {
    expect(parseTaskInput('übermorgen Friseur anrufen', NIGHT).dueAt).toBe(iso(2024, 1, 17));
  });

  it('ein Wochentag zählt ab dem logischen Tag', () => {
    expect(parseTaskInput('Dienstag 12 Uhr Zahnarzt', NIGHT).dueAt).toBe(iso(2024, 1, 16, 12, 0));
  });

  it('reine Uhrzeit ohne Datum: "sonst morgen" ab dem logischen Tag', () => {
    expect(parseTaskInput('Zahnarzt um 8', NIGHT).dueAt).toBe(iso(2024, 1, 16, 8, 0));
  });

  it('Kontrolle: derselbe Satz am Haupt-Bezugspunkt (Mo 10:00) bleibt unverändert', () => {
    expect(parseTaskInput('morgen 14 Uhr Zahnarzt', NOW).dueAt).toBe(iso(2024, 1, 16, 14, 0));
    expect(parseTaskInput('Dienstag 12 Uhr Zahnarzt', NOW).dueAt).toBe(iso(2024, 1, 16, 12, 0));
  });
});

describe('parseTaskInput — #689: "gestern"', () => {
  it('erkennt "gestern" als relativen Tag', () => {
    const result = parseTaskInput('Sport gestern gemacht', NOW);
    expect(result.title).toBe('Sport gemacht');
    expect(result.dueAt).toBe(iso(2024, 1, 14));
  });
});
