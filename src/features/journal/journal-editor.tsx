'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { mutate } from '@/local/outbox';
import { MoodScale } from '@/ui/mood-scale';
import { Toast } from '@/ui/toast';
import { useListPresence } from '@/ui/use-list-presence';
import {
  appendJournalEntry,
  deleteJournalEntry,
  msUntilNextMidnight,
  todayKey,
  type JournalEntryView,
} from './entry';
import './journal-editor.css';
import { JournalSearch } from './journal-search';
import { useJournalLock } from './lock-store';
import { useJournalEntries } from './use-journal-entries';
import { useOrphanedKey } from './use-orphaned-key';

function parseTags(raw: string): string[] {
  return raw
    .split(',')
    .map((tag) => tag.trim())
    .filter(Boolean);
}

const ENTRY_DATE_FORMATTER = new Intl.DateTimeFormat('de-DE', {
  weekday: 'short',
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
  const [searchActive, setSearchActive] = useState(false);
  const [undo, setUndo] = useState<UndoState | null>(null);
  const undoTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const entries = useJournalEntries(entryDate);
  const entryRows = useListPresence(entries ?? [], (entry) => entry.id);

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
      <JournalSearch onSelect={setEntryDate} onActiveChange={setSearchActive} />
      <div className="journal-editor">
        {!searchActive && (
          <>
            <JournalOrphanedKeyCard />
            <p className="journal-editor__date">{formatEntryDate(entryDate)}</p>
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
              {(mood !== null || text.trim() !== '') && (
                <button type="submit" className="journal-editor__submit">
                  Absenden
                </button>
              )}
            </form>
            {entryRows.length > 0 && (
              <ul className="journal-editor__entries">
                {entryRows.map((row) => (
                  <JournalEntryRow
                    key={row.key}
                    entry={row.item}
                    onDelete={handleDelete}
                    entering={row.status === 'entering'}
                    leaving={row.status === 'leaving'}
                    onAnimationEnd={row.onAnimationEnd}
                  />
                ))}
              </ul>
            )}
          </>
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

/**
 * Shown only while this device holds a displaced `journal_keys` envelope (issue
 * #518) — a first-setup race left some entries readable only under the DEK it
 * wrapped. Calm register throughout (ADR-0016, same as `journal-gate.css`'s
 * locked state): no `--danger`, a wrong secret gets the same quiet "nichts
 * geborgen" as "there was nothing to recover" (Regel 9) — the two are
 * indistinguishable on purpose, same reasoning as `journalUnlock`'s uniform
 * `WrongPassphraseError` message.
 */
function JournalOrphanedKeyCard() {
  const hasStash = useOrphanedKey();
  const { recoverOrphaned } = useJournalLock();
  const [useRecoveryKey, setUseRecoveryKey] = useState(false);
  const [secret, setSecret] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  // Recovery deletes the stash entry as part of the same operation that reports
  // the count — `useOrphanedKey()`'s liveQuery can observe that deletion (a real
  // IndexedDB round trip) and flip `hasStash` to false *while `handleSubmit` is
  // still awaiting* `recoverOrphaned`, in an entirely separate render from the
  // one that will eventually set `message`. Gating only on `!hasStash && !message`
  // still unmounts in that window (message is still null there) — and a
  // now-unmounted component discards every `setState` call still in flight,
  // silently, so the confirmation text never appears. `recovering` closes that
  // gap: set synchronously before the `await`, it keeps the card mounted for the
  // entire round trip, however the two async updates happen to interleave.
  const [recovering, setRecovering] = useState(false);

  if (!hasStash && !recovering && !message) return null;

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setRecovering(true);
    const count = await recoverOrphaned(secret, useRecoveryKey);
    setSecret('');
    setRecovering(false);
    setMessage(
      count === 0
        ? 'Keine Einträge geborgen.'
        : count === 1
          ? '1 Eintrag geborgen.'
          : `${count} Einträge geborgen.`,
    );
  }

  return (
    <form className="journal-orphaned-key" data-state="orphaned-key" onSubmit={handleSubmit}>
      <p className="journal-orphaned-key__hint">
        Auf diesem Gerät liegen Einträge mit einem älteren Schlüssel.{' '}
        {useRecoveryKey
          ? 'Entsperre sie mit dem damaligen Wiederherstellungsschlüssel.'
          : 'Entsperre sie mit der damaligen Passphrase.'}
      </p>
      <input
        type={useRecoveryKey ? 'text' : 'password'}
        className="journal-orphaned-key__input"
        value={secret}
        onChange={(event) => setSecret(event.target.value)}
        aria-label={useRecoveryKey ? 'Damaliger Wiederherstellungsschlüssel' : 'Damalige Passphrase'}
        placeholder={useRecoveryKey ? 'Wiederherstellungsschlüssel' : 'Passphrase'}
        autoComplete="off"
      />
      {message && (
        <p className="journal-orphaned-key__message" role="status">
          {message}
        </p>
      )}
      <button type="submit" className="journal-orphaned-key__submit">
        Bergen
      </button>
      <button
        type="button"
        className="journal-orphaned-key__link"
        onClick={() => {
          setUseRecoveryKey((current) => !current);
          setSecret('');
        }}
      >
        {useRecoveryKey ? 'Mit Passphrase bergen' : 'Mit Wiederherstellungsschlüssel bergen'}
      </button>
    </form>
  );
}

/** One entry in the day's list (AC3/AC4): time, mood (if set), text, tags —
 * mood and tags belong to this one entry, not the day. */
function JournalEntryRow({
  entry,
  onDelete,
  entering,
  leaving,
  onAnimationEnd,
}: {
  entry: JournalEntryView;
  onDelete: (id: string) => void;
  entering: boolean;
  leaving: boolean;
  onAnimationEnd: () => void;
}) {
  return (
    <li
      className="journal-editor__entry list-motion-item"
      data-entering={entering}
      data-leaving={leaving}
      onAnimationEnd={onAnimationEnd}
    >
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
