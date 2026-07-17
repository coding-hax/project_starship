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

  it('bleibt nur Datum/Zeit ohne Titel übrig, fällt die Rohzeile als Titel zurück', () => {
    const result = parseTaskInput('morgen um 12', NOW);
    expect(result.title).toBe('morgen um 12');
    expect(result.dueAt).toBeNull();
  });
});
