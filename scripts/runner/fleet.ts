// Aggregierter Status + Leitungsuebernahme bei mehreren Slots (#204, E5).
//
// Jeder Slot schreibt je Runde seinen eigenen Zustand nach
// SHARED_DIR/slots/<SLOT_ID>/state.json -- Inhalt UND Herzschlag in einer
// Datei, damit ein Slot ohne inhaltliche Aenderung (z. B. "CI laeuft noch")
// trotzdem als lebendig gilt: writeSlotState() mit `content: null` behaelt
// den zuletzt bekannten Text, hebt aber `updatedAtMs` an.
//
// NUR der EFFEKTIVE Leitslot aggregiert daraus EIN StatusUpdate und schreibt
// es ans Status-Issue (Blocker 4 aus der Ticket-Recherche: mehrere Slots, die
// abwechselnd denselben Titel/Body ueberschreiben, machen den Status
// wertlos). Der effektive Leitslot ist normalerweise LEAD_SLOT; faellt der
// aus (kein frischer Herzschlag mehr), uebernimmt der niedrigste Slot mit
// frischem Herzschlag (AK5) -- sichtbar im aggregierten Text.
//
// AK9 (SLOT_ID=1 allein verhaelt sich exakt wie vor #204): bei genau einem
// bekannten Slot-Zustand liefert aggregateStatus() dessen title/emoji/text
// UNVERAENDERT zurueck, ohne "Runner-Flotte"-Rahmen -- das ist die einzige
// Form, die mit den bestehenden Bash-Suiten (exakte Statustexte) identisch
// bleibt.
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { StatusUpdate } from './round.js';

export interface SlotState {
  slotId: string;
  emoji: string;
  title: string;
  text: string;
  updatedAtMs: number;
}

export interface FleetAdapter {
  /**
   * `content: null` = keine inhaltliche Aenderung diese Runde (z. B. "CI
   * laeuft noch") -- der vorhandene Text bleibt stehen, nur der Herzschlag
   * wird erneuert. Existiert noch kein Zustand, entsteht ein Platzhalter.
   */
  write(slotId: string, content: { emoji: string; title: string; text: string } | null, nowMs: number): void;
  readAll(): SlotState[];
}

export function createFleetAdapter(sharedDir: string): FleetAdapter {
  const slotsDir = join(sharedDir, 'slots');
  const fileOf = (slotId: string) => join(slotsDir, slotId, 'state.json');

  return {
    write(slotId, content, nowMs) {
      const dir = join(slotsDir, slotId);
      mkdirSync(dir, { recursive: true });
      let prev: Omit<SlotState, 'slotId' | 'updatedAtMs'> = {
        emoji: '⚪️',
        title: 'gestartet',
        text: 'Erster Takt läuft noch.',
      };
      if (content === null) {
        try {
          const raw = JSON.parse(readFileSync(fileOf(slotId), 'utf-8')) as SlotState;
          prev = { emoji: raw.emoji, title: raw.title, text: raw.text };
        } catch {
          // kein vorheriger Zustand -- Platzhalter oben bleibt stehen.
        }
      }
      const state: SlotState = { slotId, ...(content ?? prev), updatedAtMs: nowMs };
      writeFileSync(fileOf(slotId), JSON.stringify(state), 'utf-8');
    },
    readAll() {
      if (!existsSync(slotsDir)) return [];
      const result: SlotState[] = [];
      for (const slotId of readdirSync(slotsDir)) {
        try {
          const raw = JSON.parse(readFileSync(fileOf(slotId), 'utf-8')) as SlotState;
          result.push(raw);
        } catch {
          // fehlende/kaputte state.json -- dieser Slot zaehlt als "nie gesehen".
        }
      }
      return result.sort((a, b) => Number(a.slotId) - Number(b.slotId));
    },
  };
}

// Laenger als die Notbremse MAX_RUNTIME (Default 2700s/45min): waehrend ein
// Bau-Lauf laeuft, schreibt der Slot erst NACH dessen Ende wieder einen
// Zustand. Ein zu kurzer Schwellwert wuerde einen legitim arbeitenden
// Leitslot als "ausgefallen" ansehen und mitten im Lauf die Leitung
// wegnehmen. 90 Minuten geben zwei volle Notbremsen-Laengen Puffer.
export const STALE_MS = 90 * 60 * 1000;

function isFresh(state: SlotState | undefined, nowMs: number, staleMs: number): boolean {
  return state !== undefined && nowMs - state.updatedAtMs <= staleMs;
}

/**
 * Wer faehrt GERADE die globalen Waechter? LEAD_SLOT, solange sein
 * Herzschlag frisch ist ODER noch niemand je einen Zustand geschrieben hat
 * (Kaltstart -- ohne diesen Fall waere beim allerersten Tick ueberhaupt kein
 * Slot lead). Sonst der niedrigste SLOT_ID mit frischem Herzschlag unter den
 * `slotIds` (1..SLOT_COUNT). Ist gar keiner frisch (alle Slots down),
 * bleibt LEAD_SLOT die Antwort -- besser ein ruhender Leitslot als gar
 * keiner, der naechste Tick von ihm selbst raeumt dann wieder auf.
 */
export function effectiveLead(states: SlotState[], slotIds: string[], leadSlot: string, nowMs: number, staleMs = STALE_MS): string {
  if (states.length === 0) return leadSlot;
  const byId = new Map(states.map((s) => [s.slotId, s]));
  if (isFresh(byId.get(leadSlot), nowMs, staleMs)) return leadSlot;
  const live = slotIds.filter((id) => isFresh(byId.get(id), nowMs, staleMs)).sort((a, b) => Number(a) - Number(b));
  return live[0] ?? leadSlot;
}

// #331 AK2: eine zehn Minuten alte Zeile darf nicht wie eine frische aussehen
// -- das reine 💤-Symbol ab STALE_MS (90 Min., fuers Leitslot-Failover
// gedacht) greift dafuer viel zu spaet. Jede Zeile traegt deshalb ihr
// eigenes Alter, unabhaengig vom Frisch/Verfallen-Schnitt.
function formatAge(ageMs: number): string {
  const minutes = Math.floor(ageMs / 60_000);
  if (minutes < 1) return 'gerade eben';
  if (minutes < 60) return `vor ${minutes} Min.`;
  const hours = Math.floor(minutes / 60);
  const restMinutes = minutes % 60;
  return restMinutes === 0 ? `vor ${hours} Std.` : `vor ${hours} Std. ${restMinutes} Min.`;
}

const EMOJI_SEVERITY: Record<string, number> = { '🔴': 5, '🟡': 4, '🟠': 3, '🔵': 2, '🟢': 1, '⚪️': 0 };

function worstEmoji(states: SlotState[]): string {
  let worst = states[0]?.emoji ?? '⚪️';
  let worstScore = EMOJI_SEVERITY[worst] ?? 0;
  for (const s of states) {
    const score = EMOJI_SEVERITY[s.emoji] ?? 0;
    if (score > worstScore) {
      worst = s.emoji;
      worstScore = score;
    }
  }
  return worst;
}

/**
 * Baut EIN StatusUpdate aus allen bekannten Slot-Zustaenden (AK4). Bei genau
 * einem bekannten Zustand: unveraendert durchreichen (AK9). `leadSlot` hier
 * ist der EFFEKTIVE Leitslot (Ergebnis von effectiveLead()) -- weicht er vom
 * konfigurierten LEAD_SLOT ab, nennt der Text die Uebernahme (AK5).
 */
export function aggregateStatus(
  states: SlotState[],
  slotCount: number,
  configuredLeadSlot: string,
  effectiveLeadSlot: string,
  nowMs: number,
  staleMs = STALE_MS,
): StatusUpdate | null {
  if (states.length === 0) return null;
  if (states.length === 1 && slotCount <= 1) {
    const only = states[0]!;
    return { title: only.title, emoji: only.emoji, text: only.text };
  }

  const activeCount = states.filter((s) => isFresh(s, nowMs, staleMs)).length;
  const emoji = worstEmoji(states.filter((s) => isFresh(s, nowMs, staleMs)));
  const title = `Runner-Flotte · ${activeCount} von ${slotCount} aktiv`;

  const lines = states.map((s) => {
    const fresh = isFresh(s, nowMs, staleMs);
    const marker = fresh ? s.emoji : '💤';
    const age = formatAge(nowMs - s.updatedAtMs);
    return `${marker} **Slot ${s.slotId}:** ${s.title} _(${age})_`;
  });

  const takeoverNote =
    effectiveLeadSlot !== configuredLeadSlot
      ? `\n\n⚠️ **Leitslot übernommen:** Slot ${configuredLeadSlot} antwortet nicht mehr, Slot ${effectiveLeadSlot} führt Status und globale Wächter.`
      : '';

  return {
    title,
    emoji,
    text: `${emoji} **Runner-Flotte:** ${activeCount} von ${slotCount} Slots aktiv.\n\n${lines.join('\n')}${takeoverNote}`,
  };
}
