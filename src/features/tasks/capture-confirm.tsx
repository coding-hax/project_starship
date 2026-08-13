'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { FieldConfidence } from '@/features/capture/types';
import { FieldHint } from '@/ui/field-hint';
import { Sheet } from '@/ui/sheet';

const LABEL = 'Aufgabe bestätigen';
const HIGH_CONFIDENCE: FieldConfidence = { level: 'high' };

/** `datetime-local` works in the browser's local time, with no timezone suffix. */
function isoToLocalInput(iso: string): string {
  const date = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function localInputToIso(value: string): string {
  return new Date(value).toISOString();
}

function formatSummary(localValue: string): string {
  if (!localValue) return '';
  const date = new Date(localValue);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(date.getDate())}.${pad(date.getMonth() + 1)}. ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export interface CaptureConfirmDraft {
  title: string;
  dueAt: string;
  /** #691: Konfidenz je Feld — fehlt sie (z. B. ein direkt aus dem Sheet gestarteter
   * Draft ohne Erkenner-Herkunft), gilt das Feld als sicher, keine Markierung. */
  titleConfidence?: FieldConfidence;
  dateConfidence?: FieldConfidence;
  timeConfidence?: FieldConfidence;
}

export interface CaptureConfirmProps {
  /** `null` closes the sheet. */
  draft: CaptureConfirmDraft | null;
  onConfirm: (title: string, dueAt: string) => void;
  onClose: () => void;
}

const TITLE_HINT_ID = 'capture-confirm-title-hint';
const DUE_HINT_ID = 'capture-confirm-due-hint';

/**
 * Bestätigungs-Sheet für eine per Freitext erkannte Fälligkeit (issue #47 AC1).
 * Zeigt das aufgelöste absolute Datum, bevor irgendetwas angelegt wird — Sprache ist
 * unscharf, ein verhörtes "12" statt "2" soll hier auffallen, nicht still landen.
 *
 * #691 AK1/AK2: ein geratenes Titel- oder Fälligkeits-Feld (Datum und/oder Uhrzeit
 * teilen sich das eine `datetime-local`-Control) zeigt den Grundtext aus dem Erkenner
 * — AK4: sobald das Feld angefasst wird, verschwindet die Markierung wieder.
 */
export function CaptureConfirm({ draft, onConfirm, onClose }: CaptureConfirmProps) {
  const [title, setTitle] = useState('');
  const [dueAt, setDueAt] = useState('');
  const [titleEdited, setTitleEdited] = useState(false);
  const [dueAtEdited, setDueAtEdited] = useState(false);
  const titleRef = useRef<HTMLInputElement>(null);
  const wasOpenRef = useRef(false);

  const open = draft !== null;

  useEffect(() => {
    if (open && !wasOpenRef.current && draft) {
      setTitle(draft.title);
      setDueAt(isoToLocalInput(draft.dueAt));
      setTitleEdited(false);
      setDueAtEdited(false);
    }
    wasOpenRef.current = open;
  }, [open, draft]);

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmedTitle = title.trim();
    if (!trimmedTitle || !dueAt) {
      titleRef.current?.focus();
      return;
    }
    onConfirm(trimmedTitle, localInputToIso(dueAt));
  }

  const titleConfidence = draft?.titleConfidence ?? HIGH_CONFIDENCE;
  const dateConfidence = draft?.dateConfidence ?? HIGH_CONFIDENCE;
  const timeConfidence = draft?.timeConfidence ?? HIGH_CONFIDENCE;
  const showTitleHint = !titleEdited && titleConfidence.level === 'guessed';
  const showDueHint =
    !dueAtEdited && (dateConfidence.level === 'guessed' || timeConfidence.level === 'guessed');

  return (
    <Sheet open={open} onClose={onClose} label={LABEL} initialFocusRef={titleRef}>
      <form className="capture-confirm" onSubmit={handleSubmit}>
        <p className="capture-confirm__summary">{formatSummary(dueAt)}</p>
        <input
          ref={titleRef}
          type="text"
          className="capture-confirm__title"
          value={title}
          onChange={(event) => {
            setTitle(event.target.value);
            setTitleEdited(true);
          }}
          aria-label="Titel der Aufgabe"
          aria-describedby={showTitleHint ? TITLE_HINT_ID : undefined}
        />
        {showTitleHint && <FieldHint id={TITLE_HINT_ID} confidences={[titleConfidence]} />}
        <label className="capture-confirm__field">
          <span>Fälligkeit</span>
          <input
            type="datetime-local"
            className="capture-confirm__due"
            value={dueAt}
            onChange={(event) => {
              setDueAt(event.target.value);
              setDueAtEdited(true);
            }}
            aria-label="Fälligkeit"
            aria-describedby={showDueHint ? DUE_HINT_ID : undefined}
          />
        </label>
        {showDueHint && <FieldHint id={DUE_HINT_ID} confidences={[dateConfidence, timeConfidence]} />}
        <div className="capture-confirm__actions">
          <button type="button" className="capture-confirm__cancel" onClick={onClose}>
            Abbrechen
          </button>
          <button type="submit" className="capture-confirm__submit">
            Anlegen
          </button>
        </div>
      </form>
    </Sheet>
  );
}
