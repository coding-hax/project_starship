import { berlinNow, epochDay } from '@/push/schedule';
import type { TagesgesichtBlock } from '@/ui/faces';
import { greetingFor, type Greeting } from './greeting';

/**
 * Ziehung der Tagesgesicht-Figur (issue #864, AK2) — reine Funktion aus Datum
 * und Block, kein Speicher, kein `Math.random` zur Laufzeit. Saat, Mischer
 * und Grundablauf sind wortgleich zum Ticket-Pseudocode; einzige Abweichung
 * ist `ersterPlatzMussRotieren` (siehe dort) — die dritte im Ticket
 * geforderte Eigenschaft ("nie zweimal hintereinander, auch nicht über die
 * Rundengrenze") hält mit der im Ticket wörtlich vorgegebenen Prüfung gegen
 * die unrotierte Vorrunde nicht zuverlässig (AK2-Blocker, vom Menschen mit
 * "A" beantwortet).
 */

const BLOCK_FUER_GREETING: Record<Greeting, TagesgesichtBlock> = {
  'Guten Morgen': 'morgen',
  'Guten Mittag': 'mittag',
  'Guten Abend': 'abend',
  'Gute Nacht': 'nacht',
};

const GRUNDREIHE = [0, 1, 2, 3, 4, 5, 6, 7] as const;

function saat(runde: number, block: string): number {
  let h = 2166136261;
  for (const c of `${runde}:${block}`) {
    h ^= c.charCodeAt(0);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

// mulberry32
function zufall(saatWert: number): () => number {
  let s = saatWert;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function mische(basis: readonly number[], saatWert: number): number[] {
  const reihe = [...basis];
  const naechsteZufallszahl = zufall(saatWert);
  for (let i = reihe.length - 1; i > 0; i--) {
    const j = Math.floor(naechsteZufallszahl() * (i + 1));
    [reihe[i], reihe[j]] = [reihe[j], reihe[i]];
  }
  return reihe;
}

/**
 * Ob Runde `runde` an ihrem ersten Platz rotieren muss — geprüft gegen die
 * Figur, die an Runde `runde - 1`s letztem Tag tatsächlich GEZEIGT wurde
 * (Option A), nicht gegen deren unrotierte Roh-Mischung wie im Pseudocode.
 * Die Vorrunde hat dafür genau zwei mögliche letzte Figuren — ihre unrotierte
 * (`vorRoh[7]`) oder, falls sie selbst rotiert hat, `vorRoh[0]`. Passt
 * `ersteFigur` zu keiner von beiden, ist es für das Ergebnis gleichgültig, ob
 * die Vorrunde rotiert hat — nur dann (und nur dann) muss rekursiv eine
 * Runde weiter zurück aufgelöst werden. Rotation trifft nur ~1 von 8 Runden,
 * das hält die Rekursion in der Praxis flach, auch ohne harte Grenze.
 */
function ersterPlatzMussRotieren(runde: number, block: string, ersteFigur: number): boolean {
  const vorRoh = mische(GRUNDREIHE, saat(runde - 1, block));
  const unrotiertesLetztes = vorRoh[7];
  const rotiertesLetztes = vorRoh[0];

  if (ersteFigur === unrotiertesLetztes) {
    return !ersterPlatzMussRotieren(runde - 1, block, vorRoh[0]);
  }
  if (ersteFigur === rotiertesLetztes) {
    return ersterPlatzMussRotieren(runde - 1, block, vorRoh[0]);
  }
  return false;
}

function reiheFuerRunde(runde: number, block: string): number[] {
  const roh = mische(GRUNDREIHE, saat(runde, block));
  if (ersterPlatzMussRotieren(runde, block, roh[0])) {
    return [...roh.slice(1), roh[0]];
  }
  return roh;
}

/** Die Ziehung selbst, direkt über die im Ticket definierte Tagesnummer (AK3 prüft hierüber). */
export function tagesgesichtIndexFor(tagesnummer: number, block: TagesgesichtBlock): number {
  const runde = Math.floor(tagesnummer / 8);
  const platz = tagesnummer - runde * 8;
  return reiheFuerRunde(runde, block)[platz];
}

/**
 * Tagesnummer in Ortszeit (issue #864): 00:00–04:59 zählt zum Vortag, weil
 * der Nacht-Block um 22:00 anfängt und über Mitternacht läuft — sonst
 * wechselte die Figur mitten in der Nacht statt an der Blockgrenze.
 */
function tagesnummerFor(now: Date): number {
  const { dateKey, minutesOfDay } = berlinNow(now);
  const tag = epochDay(dateKey);
  return minutesOfDay < 5 * 60 ? tag - 1 : tag;
}

export function tagesgesichtFor(now: Date): { block: TagesgesichtBlock; index: number } {
  const block = BLOCK_FUER_GREETING[greetingFor(now)];
  return { block, index: tagesgesichtIndexFor(tagesnummerFor(now), block) };
}
