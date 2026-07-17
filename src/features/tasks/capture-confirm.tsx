'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Sheet } from '@/ui/sheet';

const LABEL = 'Aufgabe bestätigen';

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
}

export interface CaptureConfirmProps {
  /** `null` closes the sheet. */
  draft: CaptureConfirmDraft | null;
  onConfirm: (title: string, dueAt: string) => void;
  onClose: () => void;
}

/**
 * Bestätigungs-Sheet für eine per Freitext erkannte Fälligkeit (issue #47 AC1).
 * Zeigt das aufgelöste absolute Datum, bevor irgendetwas angelegt wird — Sprache ist
 * unscharf, ein verhörtes "12" statt "2" soll hier auffallen, nicht still landen.
 */
export function CaptureConfirm({ draft, onConfirm, onClose }: CaptureConfirmProps) {
  const [title, setTitle] = useState('');
  const [dueAt, setDueAt] = useState('');
  const titleRef = useRef<HTMLInputElement>(null);
  const wasOpenRef = useRef(false);

  const open = draft !== null;

  useEffect(() => {
    if (open && !wasOpenRef.current && draft) {
      setTitle(draft.title);
      setDueAt(isoToLocalInput(draft.dueAt));
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

  return (
    <Sheet open={open} onClose={onClose} label={LABEL} initialFocusRef={titleRef}>
      <form className="capture-confirm" onSubmit={handleSubmit}>
        <p className="capture-confirm__summary">{formatSummary(dueAt)}</p>
        <input
          ref={titleRef}
          type="text"
          className="capture-confirm__title"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          aria-label="Titel der Aufgabe"
        />
        <label className="capture-confirm__field">
          <span>Fälligkeit</span>
          <input
            type="datetime-local"
            className="capture-confirm__due"
            value={dueAt}
            onChange={(event) => setDueAt(event.target.value)}
            aria-label="Fälligkeit"
          />
        </label>
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
