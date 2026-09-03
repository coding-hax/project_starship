import {
  DATE_PREPOSITIONS, EVENT_TITLES, FRAME_PREFIXES, FRAME_SUFFIXES,
  ROUTINE_VERBS, TASK_TITLES, TIME_SLOTS, WHEN_SLOTS,
} from './slots';
import type { TimeSlot, WhenSlot } from './slots';
import { GOLD_HABITS, NOW_REF } from './types';

/**
 * Entscheidung 03.09.26: die Art fällt an einem Schlüsselwort, nie an der Uhrzeit.
 * „Kino mit Anna am Samstag um 20 Uhr" ist deshalb eine Aufgabe mit Uhrzeit.
 */
function kindOf(title: string): 'task' | 'event' {
  return /(?:^|\s)(?:termin|meeting|treffen)/iu.test(title) ? 'event' : 'task';
}
import type { GoldCase } from './types';

/** Erstes Zeichen groß — der Satzanfang, nicht der Titel. */
function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function at(day: Date, time: TimeSlot): string {
  const d = new Date(day);
  d.setHours(time.hours, time.minutes, 0, 0);
  return d.toISOString();
}

/** Deterministisch K aus N ziehen — gleiche Eingabe, gleiches Korpus, kein RNG. */
function sample<T>(items: T[], quota: number): T[] {
  if (items.length <= quota) return items;
  const out: T[] = [];
  for (let i = 0; i < quota; i++) out.push(items[Math.floor((i * items.length) / quota)]);
  return out;
}

function cross<A, B>(a: A[], b: B[]): [A, B][] {
  return a.flatMap((x) => b.map((y): [A, B] => [x, y]));
}

export interface GenerateOptions {
  now?: Date;
  /** Obergrenze je Muster; die kleinen Muster bleiben ohnehin darunter. */
  quotaPerPattern?: number;
}

/**
 * Erzeugt die generierte Korpusschicht. Der Sollwert entsteht hier aus den Slot-Werten
 * selbst — der Titel IST der eingesetzte String, das Datum kommt aus `slots.ts`'
 * Referenz-Auflösung. Der Parser wird dabei nie befragt.
 */
export function generateGoldCases(options: GenerateOptions = {}): GoldCase[] {
  const now = options.now ?? NOW_REF;
  const quota = options.quotaPerPattern ?? 4000;
  const cases: GoldCase[] = [];
  let n = 0;
  const push = (pattern: string, text: string, category: string, expect: GoldCase['expect']) => {
    cases.push({
      id: `gen:${pattern}:${String(n++).padStart(5, '0')}`,
      text,
      source: 'generiert',
      category,
      expect,
    });
  };

  // 1 — nackte Aufgabe, kein Datum. Der einfachste denkbare Fall.
  for (const title of TASK_TITLES) {
    push('nackt', title, 'Aufgabe ohne Datum', { kind: 'task', title, dueAt: null });
  }

  // 2 — Datum vorn: „Morgen Milch kaufen"
  for (const [when, title] of cross(WHEN_SLOTS, TASK_TITLES)) {
    push('datum-vorn', `${cap(when.text)} ${title}`, when.category, {
      kind: 'task',
      title,
      dueAt: when.resolve(now).toISOString(),
    });
  }

  // 3 — Datum hinten: „Milch kaufen am Freitag"
  for (const [when, title] of cross(WHEN_SLOTS, TASK_TITLES)) {
    push('datum-hinten', `${title} ${when.text}`, when.category, {
      kind: 'task',
      title,
      dueAt: when.resolve(now).toISOString(),
    });
  }

  // 4 — Termin, Zeitangabe vorn: „Am Freitag um 19 Uhr Kino mit Anna"
  const eventFront = cross(cross(WHEN_SLOTS, TIME_SLOTS), EVENT_TITLES);
  for (const [[when, time], title] of sample(eventFront, quota)) {
    push('termin-vorn', `${cap(when.text)} um ${time.text} ${title}`, `Termin · ${time.category}`, {
      kind: kindOf(title),
      title,
      dueAt: at(when.resolve(now), time),
    });
  }

  // 5 — Termin, Titel vorn: „Kino mit Anna am Freitag um 19 Uhr"
  for (const [[when, time], title] of sample(eventFront, quota)) {
    push('termin-hinten', `${title} ${when.text} um ${time.text}`, `Termin · ${when.category}`, {
      kind: kindOf(title),
      title,
      dueAt: at(when.resolve(now), time),
    });
  }

  // 6 — Routine abhaken: „Sport gemacht" / „Hab Yoga erledigt"
  const logDate = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  for (const [habit, verb] of cross(GOLD_HABITS, ROUTINE_VERBS)) {
    for (const form of [`${habit.name} ${verb}`, `Hab ${habit.name} ${verb}`]) {
      push('routine', form, 'Routine abhaken', {
        kind: 'habit_check',
        title: form,
        dueAt: null,
        habitId: habit.id,
        logDate,
      });
    }
  }

  return cases;
}

/**
 * Härtere Schicht (#erfasser-korpus): dieselben Kerne, aber in natürlicher Verpackung.
 * Die ersten Messungen zeigten, dass der Erkenner die sauberen Muster praktisch
 * vollständig beherrscht — die Fehler sitzen im Sprechrahmen drumherum.
 */
export function generateHardCases(options: GenerateOptions = {}): GoldCase[] {
  const now = options.now ?? NOW_REF;
  const quota = options.quotaPerPattern ?? 1500;
  const cases: GoldCase[] = [];
  let n = 0;
  const push = (pattern: string, text: string, category: string, expect: GoldCase['expect']) => {
    cases.push({
      id: `hard:${pattern}:${String(n++).padStart(5, '0')}`,
      text,
      source: 'generiert',
      category,
      expect,
    });
  };

  // 7 — Sprechrahmen ohne Datum: „Nicht vergessen: Müll rausbringen"
  for (const [frame, title] of cross(FRAME_PREFIXES, TASK_TITLES)) {
    push('rahmen', `${frame} ${title}`, 'Sprechrahmen', { kind: 'task', title, dueAt: null });
  }

  // 8 — nachgestellter Rahmen: „Müll rausbringen nicht vergessen"
  for (const [suffix, title] of cross(FRAME_SUFFIXES, TASK_TITLES)) {
    push('rahmen-hinten', `${title} ${suffix}`, 'Sprechrahmen', { kind: 'task', title, dueAt: null });
  }

  // 9 — Sprechrahmen MIT Datum: beide Störungen zugleich.
  const framed = cross(cross(FRAME_PREFIXES, WHEN_SLOTS), TASK_TITLES);
  for (const [[frame, when], title] of sample(framed, quota)) {
    push('rahmen-datum', `${frame} ${when.text} ${title}`, `Sprechrahmen · ${when.category}`, {
      kind: 'task',
      title,
      dueAt: when.resolve(now).toISOString(),
    });
  }

  // 10 — Präposition vor dem Datum: „Bis Freitag Präsentation fertig machen"
  const prepped = cross(cross(DATE_PREPOSITIONS, WHEN_SLOTS), TASK_TITLES);
  for (const [[prep, when], title] of sample(prepped, quota)) {
    // „bis am Freitag" ist kein Deutsch — die Präposition ersetzt das „am".
    const when_ = when.text.replace(/^am /, '');
    push('praeposition', `${cap(prep)} ${when_} ${title}`, `Präposition · ${when.category}`, {
      kind: 'task',
      title,
      dueAt: when.resolve(now).toISOString(),
    });
  }

  return cases;
}
