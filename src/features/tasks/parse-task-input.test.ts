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
