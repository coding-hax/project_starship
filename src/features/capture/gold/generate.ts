import {
  DATE_PREPOSITIONS, EVENT_TITLES, FRAME_PREFIXES, FRAME_SUFFIXES,
  HESITATION_PREFIXES, ROUTINE_VERBS, SHORT_TIME_SLOTS, SPOKEN_HEADS, STATEMENT_HEADS,
  RECURRENCE_SLOTS, TASK_TITLES, TIME_RANGE_SLOTS, TIME_SLOTS,
  WEEKDAY_ABBREVIATION_SLOTS, WHEN_SLOTS,
} from './slots';
import type { TimeRangeSlot } from './slots';
import type { TimeSlot } from './slots';
import { GOLD_HABITS, NOW_REF } from './types';

/**
 * Entscheidung 03.09.26: die Art fällt an einem Schlüsselwort, nie an der Uhrzeit.
 * „Kino mit Anna am Samstag um 20 Uhr" ist deshalb eine Aufgabe mit Uhrzeit.
 */
function kindOf(title: string): 'task' | 'event' {
  // Komposita zählen mit: „Arzttermin" trägt das Schlüsselwort genauso wie „Termin".
  return /(?:\p{L}*termine?|meeting|treffen)(?![\p{L}])/iu.test(title) ? 'event' : 'task';
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
/**
 * Kontingent der sauberen Grundmuster. Kleiner als bei den übrigen Schichten: diese
 * Muster stehen seit der ersten Messung bei 100 % und haben nie einen Fehler
 * aufgedeckt, während die kombinierten sofort drei fanden. Das hält den Gate-Test
 * unter dem Standard-Timeout, ohne dort zu sparen, wo tatsächlich etwas gefunden wird.
 */
const PLAIN_PATTERN_QUOTA = 2000;

export function generateGoldCases(options: GenerateOptions = {}): GoldCase[] {
  const now = options.now ?? NOW_REF;
  const quota = options.quotaPerPattern ?? PLAIN_PATTERN_QUOTA;
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

/**
 * Gesprochene Sprache (#erfasser-korpus, zweite Runde): der Fehlerherd, der in der
 * ersten Fassung mit dreizehn kuratierten Sätzen viel zu dünn abgedeckt war. Alle
 * Köpfe hier verschwinden rückstandsfrei, deshalb steht der Sollwert fest.
 */
export function generateSpokenCases(options: GenerateOptions = {}): GoldCase[] {
  const now = options.now ?? NOW_REF;
  const quota = options.quotaPerPattern ?? 4000;
  const cases: GoldCase[] = [];
  let n = 0;
  const push = (pattern: string, text: string, category: string, expect: GoldCase['expect']) => {
    cases.push({
      id: `spoken:${pattern}:${String(n++).padStart(5, '0')}`,
      text,
      source: 'generiert',
      category,
      expect,
    });
  };

  // N1 — Sprechkopf ohne Zeitangabe: „Mach mir ne Notiz: Reifen wechseln"
  for (const [head, title] of cross(SPOKEN_HEADS, TASK_TITLES)) {
    push('kopf', `${head} ${title}`, 'Sprechkopf', { kind: 'task', title, dueAt: null });
  }

  // N2 — Sprechkopf, Zeitangabe hinten: „Nicht vergessen: Milch kaufen am Freitag"
  const headTimed = cross(cross(SPOKEN_HEADS, WHEN_SLOTS), TASK_TITLES);
  for (const [[head, when], title] of sample(headTimed, quota)) {
    push('kopf-datum', `${head} ${title} ${when.text}`, `Sprechkopf · ${when.category}`, {
      kind: 'task',
      title,
      dueAt: when.resolve(now).toISOString(),
    });
  }

  // N3 — Aussagerahmen mit Zeitangabe in der Mitte: „Ich muss morgen Milch kaufen"
  const stated = cross(cross(STATEMENT_HEADS, WHEN_SLOTS), TASK_TITLES);
  for (const [[head, when], title] of sample(stated, quota)) {
    // „ich muss am Freitag" ist Deutsch, „ich muss am morgen" nicht — Präposition raus,
    // wo der Ausdruck ohne sie steht.
    const when_ = when.text.replace(/^am (?=morgen|heute|übermorgen)/, '');
    push('aussage', `${head} ${when_} ${title}`, `Aussagerahmen · ${when.category}`, {
      kind: 'task',
      title,
      dueAt: when.resolve(now).toISOString(),
    });
  }

  // N4 — Zögern vor dem Inhalt: „Also ähm, Milch kaufen"
  for (const [hesitation, title] of cross(HESITATION_PREFIXES, TASK_TITLES)) {
    push('zoegern', `${hesitation} ${title}`, 'Zögern', { kind: 'task', title, dueAt: null });
  }

  // N5 — Zögern UND Sprechkopf: der volle gesprochene Satz.
  const both = cross(cross(HESITATION_PREFIXES, STATEMENT_HEADS), TASK_TITLES);
  for (const [[hesitation, head], title] of sample(both, quota)) {
    push('zoegern-aussage', `${hesitation} ${head.toLowerCase()} ${title}`, 'Zögern · Aussagerahmen', {
      kind: 'task',
      title,
      dueAt: null,
    });
  }

  return cases;
}

/**
 * Telegrammstil (#erfasser-korpus): wie man tippt, wenn man es eilig hat — „Mo 14 Uhr
 * Zahnarzt", „Fr 19h Kino", „Mi. Handwerker".
 */
export function generateTelegramCases(options: GenerateOptions = {}): GoldCase[] {
  const now = options.now ?? NOW_REF;
  const quota = options.quotaPerPattern ?? 2500;
  const cases: GoldCase[] = [];
  let n = 0;
  const push = (pattern: string, text: string, category: string, expect: GoldCase['expect']) => {
    cases.push({
      id: `tele:${pattern}:${String(n++).padStart(5, '0')}`,
      text,
      source: 'generiert',
      category,
      expect,
    });
  };

  // T1 — Kürzel plus Uhrzeit: „Mo 14 Uhr Zahnarzt"
  const withTime = cross(cross(WEEKDAY_ABBREVIATION_SLOTS, TIME_SLOTS), TASK_TITLES);
  for (const [[day, time], title] of sample(withTime, quota)) {
    push('kuerzel-zeit', `${day.text} ${time.text} ${title}`, `Telegramm · ${time.category}`, {
      kind: 'task',
      title,
      dueAt: at(day.resolve(now), time),
    });
  }

  // T2 — Kürzel plus Kurzuhrzeit: „Fr 19h Kino"
  const withShort = cross(cross(WEEKDAY_ABBREVIATION_SLOTS, SHORT_TIME_SLOTS), TASK_TITLES);
  for (const [[day, time], title] of sample(withShort, quota)) {
    push('kuerzel-kurzzeit', `${day.text} ${time.text} ${title}`, 'Telegramm · Kurzuhrzeit', {
      kind: 'task',
      title,
      dueAt: at(day.resolve(now), time),
    });
  }

  // T3 — Kürzel mit Punkt, ohne Uhrzeit: „Mi. Handwerker"
  for (const [day, title] of cross(WEEKDAY_ABBREVIATION_SLOTS, TASK_TITLES)) {
    push('kuerzel-punkt', `${day.text}. ${title}`, 'Telegramm · nur Tag', {
      kind: 'task',
      title,
      dueAt: day.resolve(now).toISOString(),
    });
  }

  // T4 — Kurzuhrzeit ohne Tag: „morgen 8h Standup"
  const shortOnly = cross(cross(WHEN_SLOTS, SHORT_TIME_SLOTS), TASK_TITLES);
  for (const [[when, time], title] of sample(shortOnly, quota)) {
    push('kurzzeit', `${cap(when.text)} ${time.text} ${title}`, 'Telegramm · Kurzuhrzeit ohne Tag', {
      kind: 'task',
      title,
      dueAt: at(when.resolve(now), time),
    });
  }

  return cases;
}

/**
 * Schwierige Satzkonstruktionen (#erfasser-korpus): **ein** Eintrag, aber schwer zu
 * lesen. Zeitspannen nennen zwei Uhrzeiten und meinen die erste; Wiederholungsausdrücke
 * stehen vor dem eigentlichen Titel und dürfen ihn nicht zerreissen.
 */
export function generateComplexCases(options: GenerateOptions = {}): GoldCase[] {
  const now = options.now ?? NOW_REF;
  const quota = options.quotaPerPattern ?? 2500;
  const cases: GoldCase[] = [];
  let n = 0;
  const push = (pattern: string, text: string, category: string, expect: GoldCase['expect']) => {
    cases.push({
      id: `komplex:${pattern}:${String(n++).padStart(5, '0')}`,
      text,
      source: 'generiert',
      category,
      expect,
    });
  };

  // K1 — Zeitspanne mit Datum: „Workshop am Freitag von 9 bis 11 Uhr"
  const ranged = cross(cross(WHEN_SLOTS, TIME_RANGE_SLOTS), TASK_TITLES);
  for (const [[when, range], title] of sample(ranged, quota)) {
    const day = when.resolve(now);
    push('spanne-datum', `${title} ${when.text} ${range.text}`, `Zeitspanne · ${when.category}`, {
      kind: kindOf(title),
      title,
      dueAt: at(day, range),
      endAt: at(day, { ...range, hours: range.endHours, minutes: range.endMinutes }),
    });
  }

  // K2 — Zeitspanne ohne Datum: „Workshop von 9 bis 11 Uhr"
  for (const [range, title] of cross(TIME_RANGE_SLOTS, TASK_TITLES)) {
    const day = new Date(now);
    day.setHours(range.hours, range.minutes, 0, 0);
    // Wie jede Uhrzeit ohne Datum: heute, wenn noch in der Zukunft, sonst morgen.
    if (day <= now) day.setDate(day.getDate() + 1);
    const end = new Date(day);
    end.setHours(range.endHours, range.endMinutes, 0, 0);
    push('spanne', `${title} ${range.text}`, 'Zeitspanne ohne Datum', {
      kind: kindOf(title),
      title,
      dueAt: day.toISOString(),
      endAt: end.toISOString(),
    });
  }

  // K3 — Wiederholung vor dem Titel: „Jeden Montag Müll rausbringen"
  for (const [rule, title] of cross(RECURRENCE_SLOTS, TASK_TITLES)) {
    push('wiederholung', `${rule.text} ${title}`, rule.category, {
      kind: kindOf(title),
      title,
      // Ein Wochentag im Ausdruck nennt zugleich die erste Fälligkeit, ein blosses
      // „täglich" nicht — dann bleibt das Datum offen.
      dueAt: rule.byWeekday && rule.byWeekday.length === 1 ? weekdayDue(now, rule.byWeekday[0]) : null,
      recurrence: { freq: rule.freq, interval: rule.interval, ...(rule.byWeekday ? { byWeekday: rule.byWeekday } : {}) },
    });
  }

  return cases;
}

/** Nächstes Auftreten des Wochentags, heute eingeschlossen (Regel des Bestandsparsers). */
function weekdayDue(now: Date, dow: number): string {
  const d = new Date(now);
  d.setDate(d.getDate() + ((dow - now.getDay() + 7) % 7));
  d.setHours(9, 0, 0, 0);
  return d.toISOString();
}

/**
 * Kombinierte Muster (#erfasser-korpus): der eigentliche Härtetest. Bis hierher prüfte
 * jede Schicht ihr Muster allein — ein Sprechkopf ODER eine Wiederholung ODER eine
 * Zeitspanne. Echte Sätze stapeln sie: „Kannst du mir eintragen: jeden Montag von 9 bis
 * 11 Uhr Team-Call" ist alle drei auf einmal.
 *
 * Genau an solchen Stapeln fielen die Fehler auf, die einzeln nie sichtbar wurden —
 * etwa dass „wöchentlich montags" den Wochentag verlor, weil zwei Wiederholungs-
 * ausdrücke im selben Satz standen.
 */
export function generateCombinedCases(options: GenerateOptions = {}): GoldCase[] {
  const now = options.now ?? NOW_REF;
  const quota = options.quotaPerPattern ?? 2200;
  const cases: GoldCase[] = [];
  let n = 0;
  const push = (pattern: string, text: string, category: string, expect: GoldCase['expect']) => {
    cases.push({
      id: `kombi:${pattern}:${String(n++).padStart(5, '0')}`,
      text,
      source: 'generiert',
      category,
      expect,
    });
  };

  const recurrenceOf = (rule: (typeof RECURRENCE_SLOTS)[number]) => ({
    freq: rule.freq,
    interval: rule.interval,
    ...(rule.byWeekday ? { byWeekday: rule.byWeekday } : {}),
  });
  /**
   * Erste Fälligkeit. Ein einzelner Wochentag nennt sie direkt. Bei „täglich" oder
   * „werktags" bleibt der Tag offen — steht aber eine Uhrzeit im Satz, gilt dafür die
   * normale Regel für eine Uhrzeit ohne Datum: heute, sonst morgen.
   */
  const firstDue = (rule: (typeof RECURRENCE_SLOTS)[number], time: TimeRangeSlot | null) => {
    if (rule.byWeekday?.length === 1) {
      const d = new Date(now);
      d.setDate(d.getDate() + ((rule.byWeekday[0] - now.getDay() + 7) % 7));
      d.setHours(time ? time.hours : 9, time ? time.minutes : 0, 0, 0);
      return d;
    }
    if (!time) return null;
    const d = new Date(now);
    d.setHours(time.hours, time.minutes, 0, 0);
    if (d <= now) d.setDate(d.getDate() + 1);
    return d;
  };

  // C1 — Wiederholung + Zeitspanne: „Jeden Montag von 9 bis 11 Uhr Team-Call"
  const recurringRanges = cross(cross(RECURRENCE_SLOTS, TIME_RANGE_SLOTS), TASK_TITLES);
  for (const [[rule, range], title] of sample(recurringRanges, quota)) {
    const due = firstDue(rule, range);
    const end = due ? new Date(due) : null;
    end?.setHours(range.endHours, range.endMinutes, 0, 0);
    push('wdh-spanne', `${rule.text} ${range.text} ${title}`, 'Wiederholung + Zeitspanne', {
      kind: kindOf(title),
      title,
      dueAt: due?.toISOString() ?? null,
      endAt: end?.toISOString() ?? null,
      recurrence: recurrenceOf(rule),
    });
  }

  // C2 — Sprechkopf + Wiederholung: „Nicht vergessen: jeden Montag Müll rausbringen"
  const spokenRecurring = cross(cross(SPOKEN_HEADS, RECURRENCE_SLOTS), TASK_TITLES);
  for (const [[head, rule], title] of sample(spokenRecurring, quota)) {
    push('kopf-wdh', `${head} ${rule.text.toLowerCase()} ${title}`, 'Sprechkopf + Wiederholung', {
      kind: kindOf(title),
      title,
      dueAt: firstDue(rule, null)?.toISOString() ?? null,
      recurrence: recurrenceOf(rule),
    });
  }

  // C3 — Sprechkopf + Zeitspanne mit Datum: alle drei Ebenen auf einmal.
  const spokenRanged = cross(cross(cross(SPOKEN_HEADS, WHEN_SLOTS), TIME_RANGE_SLOTS), TASK_TITLES);
  for (const [[[head, when], range], title] of sample(spokenRanged, quota)) {
    const day = when.resolve(now);
    push('kopf-datum-spanne', `${head} ${title} ${when.text} ${range.text}`, 'Sprechkopf + Datum + Zeitspanne', {
      kind: kindOf(title),
      title,
      dueAt: at(day, range),
      endAt: at(day, { ...range, hours: range.endHours, minutes: range.endMinutes }),
    });
  }

  // C4 — Zögern + Aussagerahmen + Datum: der volle gesprochene Satz mit Zeitangabe.
  const hesitatedStated = cross(cross(cross(HESITATION_PREFIXES, STATEMENT_HEADS), WHEN_SLOTS), TASK_TITLES);
  for (const [[[hesitation, head], when], title] of sample(hesitatedStated, quota)) {
    const when_ = when.text.replace(/^am (?=morgen|heute|übermorgen)/, '');
    push('zoegern-aussage-datum', `${hesitation} ${head.toLowerCase()} ${when_} ${title}`,
      `Zögern + Aussagerahmen + ${when.category}`, {
        kind: kindOf(title),
        title,
        dueAt: when.resolve(now).toISOString(),
      });
  }

  // C5 — Telegramm-Wochentag + Zeitspanne: „Mo 9-17 Uhr Workshop"
  const teleRanged = cross(cross(WEEKDAY_ABBREVIATION_SLOTS, TIME_RANGE_SLOTS), TASK_TITLES);
  for (const [[day, range], title] of sample(teleRanged, quota)) {
    const base = day.resolve(now);
    push('telegramm-spanne', `${day.text} ${range.text} ${title}`, 'Telegramm + Zeitspanne', {
      kind: kindOf(title),
      title,
      dueAt: at(base, range),
      endAt: at(base, { ...range, hours: range.endHours, minutes: range.endMinutes }),
    });
  }

  // C6 — Präposition + Sprechkopf: „Nicht vergessen: bis Freitag Präsentation"
  const preppedSpoken = cross(cross(cross(SPOKEN_HEADS, DATE_PREPOSITIONS), WHEN_SLOTS), TASK_TITLES);
  for (const [[[head, prep], when], title] of sample(preppedSpoken, quota)) {
    const when_ = when.text.replace(/^am /, '');
    push('kopf-praeposition', `${head} ${prep} ${when_} ${title}`, 'Sprechkopf + Präposition', {
      kind: kindOf(title),
      title,
      dueAt: when.resolve(now).toISOString(),
    });
  }

  return cases;
}
