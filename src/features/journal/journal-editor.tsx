'use client';

import { useEffect, useRef, useState } from 'react';
import type { JournalContent } from '@/crypto/journal';
import type { JournalConflict } from '@/local/dexie';
import { MoodScale } from '@/ui/mood-scale';
import { decryptJournalConflict, restoreJournalConflict } from './conflicts';
import { loadJournalEntry, saveJournalEntry } from './entry';
import './journal-editor.css';
import { useJournalConflicts } from './use-journal-conflicts';

/** Text/tags autosave debounce — mood saves immediately (a tap is the whole
 * interaction, there is nothing left to batch). */
const SAVE_DEBOUNCE_MS = 500;

/** Local calendar day, `YYYY-MM-DD` — device-local, not UTC (`toISOString`
 * would drift a day near midnight for anyone west of Greenwich). Playwright's
 * `page.clock` pins `Date` itself, so this stays deterministic in tests. */
function todayKey(): string {
  return new Date().toLocaleDateString('en-CA');
}

function parseTags(raw: string): string[] {
  return raw
    .split(',')
    .map((tag) => tag.trim())
    .filter(Boolean);
}

function contentToFields(content: JournalContent | null) {
  return {
    mood: content?.mood ? Number(content.mood) : null,
    text: content?.text ?? '',
    tagsInput: (content?.tags ?? []).join(', '),
  };
}

/**
 * The one entry per day (issue #340, S3b of #302): mood scale first, then
 * free text, then tags — all three land in a single ciphertext (ADR-0004).
 * Every change goes through the outbox (`saveJournalEntry` → `writeJournalEntry`),
 * never a direct API call (CLAUDE.md rule 8).
 */
export function JournalEditor() {
  const [entryDate] = useState(todayKey);
  const [mood, setMood] = useState<number | null>(null);
  const [text, setText] = useState('');
  const [tagsInput, setTagsInput] = useState('');
  const loadedRef = useRef(false);
  const saveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const conflicts = useJournalConflicts(entryDate);

  useEffect(() => {
    loadedRef.current = false;
    let cancelled = false;
    void loadJournalEntry(entryDate).then((content) => {
      if (cancelled) return;
      const fields = contentToFields(content);
      setMood(fields.mood);
      setText(fields.text);
      setTagsInput(fields.tagsInput);
      loadedRef.current = true;
    });
    return () => {
      cancelled = true;
    };
  }, [entryDate]);

  function scheduleSave(
    next: { mood: number | null; text: string; tagsInput: string },
    immediate: boolean,
  ) {
    // A save before the initial load lands would overwrite whatever is already
    // stored with the still-empty defaults.
    if (!loadedRef.current) return;

    if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
    const run = () =>
      void saveJournalEntry(entryDate, {
        text: next.text,
        mood: next.mood === null ? undefined : String(next.mood),
        tags: parseTags(next.tagsInput),
      });

    if (immediate) run();
    else saveTimeoutRef.current = setTimeout(run, SAVE_DEBOUNCE_MS);
  }

  function handleMoodChange(next: number | null) {
    setMood(next);
    scheduleSave({ mood: next, text, tagsInput }, true);
  }

  function handleTextChange(next: string) {
    setText(next);
    scheduleSave({ mood, text: next, tagsInput }, false);
  }

  function handleTagsChange(next: string) {
    setTagsInput(next);
    scheduleSave({ mood, text, tagsInput: next }, false);
  }

  async function handleRestore(conflict: JournalConflict) {
    await restoreJournalConflict(conflict);
    const fields = contentToFields(await loadJournalEntry(entryDate));
    setMood(fields.mood);
    setText(fields.text);
    setTagsInput(fields.tagsInput);
  }

  return (
    <div className="journal-editor">
      <MoodScale value={mood} onChange={handleMoodChange} />
      <textarea
        className="journal-editor__text"
        value={text}
        onChange={(event) => handleTextChange(event.target.value)}
        placeholder="Was ist heute passiert?"
        aria-label="Journal-Text"
      />
      <input
        type="text"
        className="journal-editor__tags"
        value={tagsInput}
        onChange={(event) => handleTagsChange(event.target.value)}
        placeholder="Tags, mit Komma getrennt"
        aria-label="Tags"
      />
      {conflicts?.map((conflict) => (
        <JournalConflictBanner key={conflict.id} conflict={conflict} onRestore={handleRestore} />
      ))}
    </div>
  );
}

/** A displaced version of today's entry (ADR-0017 point 3) — shown, never
 * silently dropped (AC8). Decrypts only its own copy, independent of the
 * editor's current draft. */
function JournalConflictBanner({
  conflict,
  onRestore,
}: {
  conflict: JournalConflict;
  onRestore: (conflict: JournalConflict) => void;
}) {
  const [content, setContent] = useState<JournalContent | null>(null);

  useEffect(() => {
    void decryptJournalConflict(conflict).then(setContent);
  }, [conflict]);

  if (!content) return null;

  return (
    <div className="journal-editor__conflict" role="status">
      <p className="journal-editor__conflict-hint">
        Ein anderer Eintrag für diesen Tag wurde überschrieben: „{content.text || '(kein Text)'}“
      </p>
      <button
        type="button"
        className="journal-editor__conflict-restore"
        onClick={() => onRestore(conflict)}
      >
        Wiederherstellen
      </button>
    </div>
  );
}
