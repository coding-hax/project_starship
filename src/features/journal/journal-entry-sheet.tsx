'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { MoodScale } from '@/ui/mood-scale';
import { Sheet } from '@/ui/sheet';
import { appendJournalEntry, todayKey } from './entry';
import './journal-entry-sheet.css';

export const JOURNAL_ENTRY_SHEET_LABEL = 'Eintragen';

function parseTags(raw: string): string[] {
  return raw
    .split(',')
    .map((tag) => tag.trim())
    .filter(Boolean);
}

export interface JournalEntrySheetProps {
  open: boolean;
  onClose: () => void;
}

/**
 * The create sheet (AK2, #700/#701): mood, free text, tags, submitted
 * explicitly via "Eintragen" — never an edit, every submission is its own
 * entry (issue #376). Always starts empty on open, same `wasOpenRef`
 * closed->open pattern as `HabitEditor`'s create mode, since this sheet is
 * reused across openings rather than remounted.
 */
export function JournalEntrySheet({ open, onClose }: JournalEntrySheetProps) {
  const [mood, setMood] = useState<number | null>(null);
  const [text, setText] = useState('');
  const [tagsInput, setTagsInput] = useState('');
  const textRef = useRef<HTMLTextAreaElement>(null);
  const wasOpenRef = useRef(false);

  useEffect(() => {
    if (open && !wasOpenRef.current) {
      setMood(null);
      setText('');
      setTagsInput('');
    }
    wasOpenRef.current = open;
  }, [open]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmedText = text.trim();
    const tags = parseTags(tagsInput);
    const submittedMood = mood;
    if (!trimmedText && submittedMood === null && tags.length === 0) return;

    // Clear synchronously, before awaiting the write (same race guard as the
    // pre-#701 inline form: a fast second open must not inherit stale text).
    setMood(null);
    setText('');
    setTagsInput('');
    onClose();

    await appendJournalEntry(todayKey(), {
      text: trimmedText,
      mood: submittedMood === null ? undefined : String(submittedMood),
      tags,
    });
  }

  return (
    <Sheet open={open} onClose={onClose} label={JOURNAL_ENTRY_SHEET_LABEL} initialFocusRef={textRef}>
      {/* Gated on `open` — same reason as quick-add.tsx's "Mehr" fields and
          task-editor.tsx's parent select: a closed `<dialog>` keeps its
          children in the DOM, and this form's submit button shares its
          accessible name ("Eintragen") with the FAB that opens it (AK2,
          #701) — left mounted while closed, that's a second permanent match
          for every page-wide "Eintragen" query. */}
      {open && (
        <form className="journal-editor__form" onSubmit={handleSubmit}>
          <MoodScale value={mood} onChange={setMood} />
          <textarea
            ref={textRef}
            className="journal-editor__text"
            value={text}
            onChange={(event) => setText(event.target.value)}
            placeholder="Was ist heute passiert?"
            aria-label="Journal-Text"
          />
          <input
            type="text"
            className="journal-editor__tags"
            value={tagsInput}
            onChange={(event) => setTagsInput(event.target.value)}
            placeholder="Tags, mit Komma getrennt"
            aria-label="Tags"
          />
          {(mood !== null || text.trim() !== '') && (
            <button type="submit" className="journal-editor__submit">
              {JOURNAL_ENTRY_SHEET_LABEL}
            </button>
          )}
        </form>
      )}
    </Sheet>
  );
}
