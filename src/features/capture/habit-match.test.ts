import { describe, expect, it } from 'vitest';
import { matchHabit } from './habit-match';

const HABITS = [
  { id: 'h-sport', name: 'Sport' },
  { id: 'h-yoga', name: 'Yoga' },
  { id: 'h-morgenroutine', name: 'Morgenroutine' },
];

describe('matchHabit', () => {
  it('starker Treffer: alle Habit-Tokens im Text enthalten', () => {
    const result = matchHabit('ich habe heute Sport gemacht', HABITS);
    expect(result).toEqual({ matched: true, habitId: 'h-sport', confidence: 'high' });
  });

  it('Diakritika werden gefaltet (Diktat-Varianten treffen)', () => {
    const habits = [{ id: 'h-uebung', name: 'Übung' }];
    const result = matchHabit('Ubung gemacht', habits);
    expect(result).toEqual({ matched: true, habitId: 'h-uebung', confidence: 'high' });
  });

  it('schwacher Treffer: teilweise Überlappung bei mehrteiligem Namen', () => {
    const habits = [{ id: 'h-morgenlauf', name: 'Morgen Lauf' }];
    const result = matchHabit('Lauf gemacht', habits);
    expect(result).toEqual({ matched: true, habitId: 'h-morgenlauf', confidence: 'low' });
  });

  it('kein Treffer: keine Überlappung', () => {
    const result = matchHabit('Wäsche aufhängen', HABITS);
    expect(result).toEqual({ matched: false, habitId: null, confidence: 'low' });
  });

  it('mehrere gleich starke Treffer: confidence low, keine habitId', () => {
    const result = matchHabit('Sport und Yoga gemacht', HABITS);
    expect(result).toEqual({ matched: true, habitId: null, confidence: 'low' });
  });

  it('leere Habit-Liste -> kein Treffer', () => {
    const result = matchHabit('Sport gemacht', []);
    expect(result).toEqual({ matched: false, habitId: null, confidence: 'low' });
  });
});
