'use client';

import { useRef, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { Sheet } from '@/ui/sheet';
import { setCaptureDraft } from './capture-draft-store';
import { parseTaskInput } from './parse-task-input';

const LABEL = 'Aufgabe erfassen';

/**
 * Erfassungsknopf in der Titelzeile von `/uebersicht` (issue #618, S1 von #617):
 * ein Freitextfeld, dessen geparstes Ergebnis über den Draft-Store nach `/aufgaben`
 * wandert, wo `QuickAddTask` es im Mount-Effect konsumiert und durch **dieselbe**
 * Sheet-vs-Direkt-Entscheidung schickt wie eine dort getippte Eingabe.
 */
export function UebersichtCapture() {
  const [open, setOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const router = useRouter();

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const raw = inputRef.current?.value.trim();

    if (!raw) {
      inputRef.current?.focus();
      return;
    }

    const parsed = parseTaskInput(raw, new Date());
    setCaptureDraft({ items: [parsed] });
    if (inputRef.current) inputRef.current.value = '';
    setOpen(false);
    router.push('/aufgaben');
  }

  return (
    <>
      <button
        type="button"
        className="uebersicht-capture__button"
        onClick={() => setOpen(true)}
        aria-label={LABEL}
      >
        <span aria-hidden="true">+</span>
      </button>
      <Sheet open={open} onClose={() => setOpen(false)} label={LABEL} initialFocusRef={inputRef}>
        <form className="quick-add" onSubmit={handleSubmit}>
          <input
            ref={inputRef}
            type="text"
            name="title"
            className="quick-add__input"
            placeholder="Todo Titel"
            aria-label="Titel der Aufgabe"
          />
          <button type="submit" className="quick-add__submit">
            Hinzufügen
          </button>
        </form>
      </Sheet>
    </>
  );
}
