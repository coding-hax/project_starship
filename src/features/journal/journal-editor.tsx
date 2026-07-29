'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { JournalContent } from '@/crypto/journal';
import type { JournalConflict } from '@/local/dexie';
import { mutate } from '@/local/outbox';
import { MoodScale } from '@/ui/mood-scale';
import { Toast } from '@/ui/toast';
import { decryptJournalConflict, restoreJournalConflict } from './conflicts';
import {
  appendJournalEntry,
  deleteJournalEntry,
  msUntilNextMidnight,
  todayKey,
  type JournalEntryView,
} from './entry';
import './journal-editor.css';
import { JournalSearch } from './journal-search';
import { useJournalConflicts } from './use-journal-conflicts';
import { useJournalEntries } from './use-journal-entries';

function parseTags(raw: string): string[] {
  return raw
    .split(',')
    .map((tag) => tag.trim())
    .filter(Boolean);
}

const ENTRY_DATE_FORMATTER = new Intl.DateTimeFormat('de-DE', {
  weekday: 'long',
  day: 'numeric',
  month: 'long',
});

const ENTRY_TIME_FORMATTER = new Intl.DateTimeFormat('de-DE', {
  hour: '2-digit',
  minute: '2-digit',
});

/** Above the entry list (issue #374 AC1) — the day whose entries are shown,
 * spelled out in German like every other date on this page. */
function formatEntryDate(entryDate: string): string {
  const [year, month, day] = entryDate.split('-').map(Number);
  return ENTRY_DATE_FORMATTER.format(new Date(year, month - 1, day));
}

function formatEntryTime(createdAt: string): string {
  return ENTRY_TIME_FORMATTER.format(new Date(createdAt));
}

const UNDO_TIMEOUT_MS = 5000;

interface UndoState {
  id: string;
}

/**
 * A day's worth of entries (issue #376, replacing S3b's one-entry-per-day
 * autosave editor): mood, free text, tags — submitted explicitly, never
 * autosaved. Below the form, every entry of the visible day, newest first
 * (AC3), each deletable over the existing soft-delete/outbox path (AC5). Every
 * write goes through the outbox (`appendJournalEntry` → `writeJournalEntry`),
 * never a direct API call (CLAUDE.md rule 8).
 */
export function JournalEditor() {
  const [entryDate, setEntryDate] = useState(todayKey);
  const [mood, setMood] = useState<number | null>(null);
  const [text, setText] = useState('');
  const [tagsInput, setTagsInput] = useState('');
  const [undo, setUndo] = useState<UndoState | null>(null);
  const undoTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const entries = useJournalEntries(entryDate);
  const conflicts = useJournalConflicts(entryDate);

  // AC2: staying open across midnight rolls the visible day forward on its
  // own, no reload. A single timeout scheduled for the exact next midnight
  // (not a poll) also closes the AC3 gap it used to be seeded from: a
  // submission right after midnight always sees the day already rolled over.
  // `trackedToday` guards against clobbering a day picked via search (AC6,
  // #341) — the roll only applies while `entryDate` is still following
  // "today" itself.
  useEffect(() => {
    let timeout: ReturnType<typeof setTimeout>;
    let trackedToday = todayKey();
    function scheduleNext() {
      timeout = setTimeout(() => {
        const previousToday = trackedToday;
        trackedToday = todayKey();
        setEntryDate((current) => (current === previousToday ? trackedToday : current));
        scheduleNext();
      }, msUntilNextMidnight());
    }
    scheduleNext();
    return () => clearTimeout(timeout);
  }, []);

  function dismissUndo() {
    if (undoTimeoutRef.current !== null) {
      clearTimeout(undoTimeoutRef.current);
      undoTimeoutRef.current = null;
    }
    setUndo(null);
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmedText = text.trim();
    const tags = parseTags(tagsInput);
    const submittedMood = mood;
    if (!trimmedText && submittedMood === null && tags.length === 0) return;

    // Clear synchronously, before awaiting the write (AC2: "Nach dem Absenden
    // ist das Feld leer"). Clearing only after the await resolved raced any
    // typing that happened in the meantime — a fast second submit could get
    // its just-typed text wiped by this submit's delayed clear.
    setMood(null);
    setText('');
    setTagsInput('');

    await appendJournalEntry(entryDate, {
      text: trimmedText,
      mood: submittedMood === null ? undefined : String(submittedMood),
      tags,
    });
  }

  async function handleDelete(id: string) {
    dismissUndo();
    await deleteJournalEntry(id);
    setUndo({ id });
    undoTimeoutRef.current = setTimeout(dismissUndo, UNDO_TIMEOUT_MS);
  }

  async function handleUndoDelete() {
    if (!undo) return;
    const { id } = undo;
    dismissUndo();
    await mutate({ table: 'journal_entries', rowId: id, op: 'restore' });
  }

  return (
    <>
      <JournalSearch onSelect={setEntryDate} />
      <div className="journal-editor">
        <form className="journal-editor__form" onSubmit={handleSubmit}>
          <MoodScale value={mood} onChange={setMood} />
          <textarea
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
          <button type="submit" className="journal-editor__submit">
            Absenden
          </button>
        </form>
        {conflicts?.map((conflict) => (
          <JournalConflictBanner key={conflict.id} conflict={conflict} onRestore={restoreJournalConflict} />
        ))}
        <p className="journal-editor__date">{formatEntryDate(entryDate)}</p>
        {entries && entries.length > 0 && (
          <ul className="journal-editor__entries">
            {entries.map((entry) => (
              <JournalEntryRow key={entry.id} entry={entry} onDelete={handleDelete} />
            ))}
          </ul>
        )}
      </div>
      {undo && (
        <Toast
          message="Eintrag gelöscht"
          actionLabel="Rückgängig"
          onAction={handleUndoDelete}
          onDismiss={dismissUndo}
        />
      )}
    </>
  );
}

/** One entry in the day's list (AC3/AC4): time, mood (if set), text, tags —
 * mood and tags belong to this one entry, not the day. */
function JournalEntryRow({
  entry,
  onDelete,
}: {
  entry: JournalEntryView;
  onDelete: (id: string) => void;
}) {
  return (
    <li className="journal-editor__entry">
      <div className="journal-editor__entry-header">
        <time className="journal-editor__entry-time" dateTime={entry.createdAt}>
          {formatEntryTime(entry.createdAt)}
        </time>
        {entry.content.mood && (
          <span className="journal-editor__entry-mood">Stimmung {entry.content.mood}/10</span>
        )}
        <button
          type="button"
          className="journal-editor__entry-delete"
          aria-label="Eintrag löschen"
          onClick={() => onDelete(entry.id)}
        >
          Löschen
        </button>
      </div>
      {entry.content.text && <p className="journal-editor__entry-text">{entry.content.text}</p>}
      {(entry.content.tags?.length ?? 0) > 0 && (
        <p className="journal-editor__entry-tags">{entry.content.tags!.join(', ')}</p>
      )}
    </li>
  );
}

/** A displaced version of an entry for this day (ADR-0017 point 3) — shown,
 * never silently dropped (AC8). Decrypts only its own copy. Restoring appends
 * it as a new entry (conflicts.ts) — there is no single "current entry" per
 * day to overwrite anymore. */
function JournalConflictBanner({
  conflict,
  onRestore,
}: {
  conflict: JournalConflict;
  onRestore: (conflict: JournalConflict) => Promise<void>;
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
