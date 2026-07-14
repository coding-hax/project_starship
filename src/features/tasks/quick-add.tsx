'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { mutate } from '@/local/outbox';
import { Fab } from '@/ui/fab';
import { Sheet } from '@/ui/sheet';

const LABEL = 'Aufgabe erfassen';

function isTypingTarget(target: EventTarget | null): boolean {
  const tag = (target as HTMLElement | null)?.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA';
}

/**
 * FAB + bottom sheet with a single title field. The whole point (VISION.md: under
 * 5 seconds, no navigation) is that saving never leaves the "Aufgaben" view — the
 * task lands in IndexedDB directly, the outbox picks it up whenever the network does.
 */
export function QuickAddTask() {
  const [open, setOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

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

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const title = inputRef.current?.value.trim();

    if (!title) {
      inputRef.current?.focus();
      return;
    }

    if (inputRef.current) inputRef.current.value = '';
    setOpen(false);
    await mutate({ table: 'tasks', op: 'upsert', payload: { title } });
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
            placeholder="Was steht an?"
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
