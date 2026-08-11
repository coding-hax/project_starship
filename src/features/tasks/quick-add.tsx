'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useCapturePrefs } from '@/features/settings/use-capture-prefs';
import { mutate } from '@/local/outbox';
import { Fab } from '@/ui/fab';
import { Sheet } from '@/ui/sheet';
import { Toast } from '@/ui/toast';
import { consumeCaptureDraft } from './capture-draft-store';
import { CaptureConfirm, type CaptureConfirmDraft } from './capture-confirm';
import { parseTaskInput, type ParsedTaskInput } from './parse-task-input';

const LABEL = 'Aufgabe erfassen';
const UNDO_TIMEOUT_MS = 5000;

function isTypingTarget(target: EventTarget | null): boolean {
  const tag = (target as HTMLElement | null)?.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA';
}

interface UndoState {
  taskId: string;
  title: string;
}

/**
 * FAB + bottom sheet with a single title field. The whole point (VISION.md: under
 * 5 seconds, no navigation) is that saving never leaves the "Aufgaben" view — the
 * task lands in IndexedDB directly, the outbox picks it up whenever the network does.
 *
 * issue #47: der Titel wird durch `parseTaskInput` geschickt. Erkennt der Text ein
 * Datum, öffnet sich ein Bestätigungs-Sheet mit dem aufgelösten Termin — außer die
 * Einstellung "ohne Bestätigung direkt anlegen" ist an, dann legt der Direkt-Pfad
 * sofort an und zeigt stattdessen einen Undo-Toast als Sicherheitsnetz (AC4).
 */
export function QuickAddTask() {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<CaptureConfirmDraft | null>(null);
  const [undo, setUndo] = useState<UndoState | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const undoTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { directCapture } = useCapturePrefs();

  // Desktop shortcut (DESIGN_SYSTEM.md: `n` = neu). Ignored while typing elsewhere,
  // so it cannot hijack a keystroke in some other field.
  useEffect(() => {
    function onKeyDown(event: globalThis.KeyboardEvent) {
      if (event.key !== 'n' || isTypingTarget(event.target)) return;
      event.preventDefault();
      setOpen(true);
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  function dismissUndo() {
    if (undoTimeoutRef.current !== null) {
      clearTimeout(undoTimeoutRef.current);
      undoTimeoutRef.current = null;
    }
    setUndo(null);
  }

  async function createTask(title: string, dueAt: string | null, showUndo: boolean) {
    // Anchors the chronological running list (issue #88) — set once, here, and
    // never touched again by an edit.
    const payload: Record<string, unknown> = { title, createdAt: new Date().toISOString() };
    if (dueAt) payload.dueAt = dueAt;
    const taskId = await mutate({ table: 'tasks', op: 'upsert', payload });

    if (showUndo) {
      dismissUndo();
      setUndo({ taskId, title });
      undoTimeoutRef.current = setTimeout(dismissUndo, UNDO_TIMEOUT_MS);
    }
  }

  async function handleUndo() {
    if (!undo) return;
    const { taskId } = undo;
    dismissUndo();
    // Rückgängig macht die Anlage per Tombstone, nicht per Hard-Delete (CLAUDE.md
    // rule 8 / ADR-0001 §3) — funktioniert damit auch offline.
    await mutate({ table: 'tasks', rowId: taskId, op: 'delete' });
  }

  // issue #618: derselbe Entscheidungsweg für Eingaben aus diesem Sheet und für
  // Drafts, die von der Übersicht her über den Draft-Store ankommen — ein einziger
  // Entscheidungsort statt zweier Kopien der Sheet-vs-Direkt-Logik.
  async function applyParsed(parsed: ParsedTaskInput) {
    if (parsed.dueAt && !directCapture) {
      setDraft({ title: parsed.title, dueAt: parsed.dueAt });
      return;
    }

    // Ein Undo-Toast ersetzt bewusst das übersprungene Bestätigungs-Sheet — nur
    // nötig, wenn dabei tatsächlich ein Datum ohne Review gesetzt wurde (AC4).
    await createTask(parsed.title, parsed.dueAt, parsed.dueAt !== null);
  }

  // Konsumiert einen Draft, der über die Erfassung auf /uebersicht angelegt wurde
  // (issue #618) — genau einmal pro Mount, der Store leert sich selbst beim Lesen.
  // `queueMicrotask` schiebt `applyParsed` (und sein mögliches `setDraft`) hinter
  // einen echten Tick, statt synchron im Effekt-Body selbst Zustand zu setzen.
  useEffect(() => {
    const batch = consumeCaptureDraft();
    const item = batch?.items[0];
    if (item) queueMicrotask(() => void applyParsed(item));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const raw = inputRef.current?.value.trim();

    if (!raw) {
      inputRef.current?.focus();
      return;
    }

    if (inputRef.current) inputRef.current.value = '';
    setOpen(false);

    const parsed = parseTaskInput(raw, new Date());
    await applyParsed(parsed);
  }

  async function handleConfirm(title: string, dueAt: string) {
    setDraft(null);
    await createTask(title, dueAt, false);
  }

  return (
    <>
      <Fab label={LABEL} onClick={() => setOpen(true)} />
      <Sheet open={open} onClose={() => setOpen(false)} label={LABEL} initialFocusRef={inputRef}>
        <form className="quick-add" onSubmit={handleSubmit}>
          <input
            ref={inputRef}
            type="text"
            name="title"
            className="quick-add__input"
            placeholder="Sprich oder tippe: „Arzt anrufen morgen um 12“"
            aria-label="Titel der Aufgabe"
          />
          <button type="submit" className="quick-add__submit">
            Hinzufügen
          </button>
        </form>
      </Sheet>
      <CaptureConfirm draft={draft} onConfirm={handleConfirm} onClose={() => setDraft(null)} />
      {undo && (
        <Toast
          message={`„${undo.title}" angelegt`}
          actionLabel="Rückgängig"
          onAction={handleUndo}
          onDismiss={dismissUndo}
        />
      )}
    </>
  );
}
