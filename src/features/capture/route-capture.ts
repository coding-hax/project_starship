import { berlinNow } from '@/push/schedule';
import type { EventCaptureDraftItem, TaskCaptureDraftItem } from '../tasks/capture-draft-store';
import { recognizeLocally } from './local-recognizer';
import type { CaptureContext, CaptureKind } from './types';

const ONE_HOUR_MS = 60 * 60 * 1000;

const KIND_MODULE_ID: Record<CaptureKind, string> = {
  task: 'aufgaben',
  event: 'kalender',
  habit_check: 'routinen',
};

/**
 * Welche `CaptureKind`s der Aufruf anbieten darf, aus dem Modul-Ein/Aus-Zustand
 * (`use-modules.ts`) — Journal taucht hier nie auf, weil `CaptureKind` es gar
 * nicht kennt (CLAUDE.md Regel 9).
 */
export function allowedCaptureKinds(isActive: (id: string) => boolean): CaptureKind[] {
  return (Object.keys(KIND_MODULE_ID) as CaptureKind[]).filter((kind) => isActive(KIND_MODULE_ID[kind]));
}

export type CaptureRouteDecision =
  | { action: 'task'; draft: TaskCaptureDraftItem }
  | { action: 'event'; draft: EventCaptureDraftItem }
  | { action: 'habit-check'; habitId: string }
  | { action: 'habit-review' };

/**
 * Die eine Stelle, die "wohin damit" entscheidet (issue #619) — ruft den
 * Recognizer (#621) auf und übersetzt sein Ergebnis in Navigation/Prefill/
 * Mutation. Nur das erste erkannte Element (`items[0]`) — Mehrfach-Erfassung
 * käme später genau hier dazu (S1 von #617).
 *
 * `event`-Übersetzung: unter dem aktuellen Klassifikator (local-recognizer.ts)
 * gewinnt `event` nur bei erkannter expliziter Uhrzeit — ein reines Datum ohne
 * Uhrzeit bleibt `task` (#621 AC5). Ein `event`-Ergebnis mit `dueAt` bedeutet
 * also immer eine explizite Uhrzeit; ohne `dueAt` (reines Vokabular, z. B.
 * "Meeting mit Chef") gibt es weder Datum noch Uhrzeit — das ist der
 * ganztägig-Fall, vorbefüllt auf den heutigen Tag.
 */
export function decideCaptureRoute(text: string, ctx: CaptureContext): CaptureRouteDecision {
  const [draft] = recognizeLocally(text, ctx).items;

  if (draft.kind === 'task') {
    return {
      action: 'task',
      draft: {
        kind: 'task',
        title: draft.title,
        dueAt: draft.dueAt,
        needsConfirmation: draft.confidence === 'low',
      },
    };
  }

  if (draft.kind === 'event') {
    if (draft.dueAt) {
      const endsAt = new Date(new Date(draft.dueAt).getTime() + ONE_HOUR_MS).toISOString();
      return {
        action: 'event',
        draft: {
          kind: 'event',
          title: draft.title,
          allDay: false,
          startsAt: draft.dueAt,
          endsAt,
          startDate: null,
          endDate: null,
        },
      };
    }
    const today = berlinNow(ctx.now).dateKey;
    return {
      action: 'event',
      draft: {
        kind: 'event',
        title: draft.title,
        allDay: true,
        startsAt: null,
        endsAt: null,
        startDate: today,
        endDate: today,
      },
    };
  }

  if (draft.confidence === 'high' && draft.habitId) {
    return { action: 'habit-check', habitId: draft.habitId };
  }
  return { action: 'habit-review' };
}
