'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { MoodScale } from '@/ui/mood-scale';
import { Sheet } from '@/ui/sheet';
import { appendJournalEntry, todayKey } from './entry';
import './journal-entry-sheet.css';

export const JOURNAL_ENTRY_SHEET_LABEL = 'Eintragen';

const JOURNAL_FORM_ID = 'journal-entry-form';

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

  const canSubmit = mood !== null || text.trim() !== '';

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmedText = text.trim();
    const tags = parseTags(tagsInput);
    const submittedMood = mood;
    // Tags allein reichen nicht (AK4) — deckt u. a. Enter im Tags-Feld ab, das
    // sonst ohne Mood/Text einen leeren Eintrag anlegen würde.
    if (!trimmedText && submittedMood === null) return;

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
    <Sheet
      open={open}
      onClose={onClose}
      label={JOURNAL_ENTRY_SHEET_LABEL}
      initialFocusRef={textRef}
      header={{ actionLabel: JOURNAL_ENTRY_SHEET_LABEL, formId: JOURNAL_FORM_ID, disabled: !canSubmit }}
    >
      {/* Gated on `open` — same reason as quick-add.tsx's "Mehr" fields and
          task-editor.tsx's parent select: a closed `<dialog>` keeps its
          children in the DOM, and the AK1 test counts `.journal-editor__form`
          before the sheet has ever been opened. */}
      {open && (
        <form id={JOURNAL_FORM_ID} className="journal-editor__form" onSubmit={handleSubmit}>
          <textarea
            ref={textRef}
            className="journal-editor__text"
            value={text}
            onChange={(event) => setText(event.target.value)}
            placeholder="Was ist heute passiert?"
            aria-label="Journal-Text"
          />
          <div className="journal-editor__footer">
            <MoodScale value={mood} onChange={setMood} />
            <input
              type="text"
              className="journal-editor__tags"
              value={tagsInput}
              onChange={(event) => setTagsInput(event.target.value)}
              placeholder="Tags, mit Komma getrennt"
              aria-label="Tags"
            />
          </div>
        </form>
      )}
    </Sheet>
  );
}
