'use client';

import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { Fab } from '@/ui/fab';
import { useListPresence, type ListPresenceRow } from '@/ui/use-list-presence';
import { deleteJournalEntry, todayKey } from './entry';
import { JournalEntrySheet, JOURNAL_ENTRY_SHEET_LABEL } from './journal-entry-sheet';
import './journal-editor.css';
import { JournalSearch } from './journal-search';
import { useJournalSearchMode } from './journal-view-mode';
import { useJournalLock } from './lock-store';
import { useJournalEntries } from './use-journal-entries';
import { useOrphanedKey } from './use-orphaned-key';
import type { JournalSearchEntry } from './search';

const WEEKDAY_LONG_FORMATTER = new Intl.DateTimeFormat('de-DE', { weekday: 'long' });

const DAY_DATE_FORMATTER = new Intl.DateTimeFormat('de-DE', {
  weekday: 'short',
  day: 'numeric',
  month: 'long',
});

const ENTRY_TIME_FORMATTER = new Intl.DateTimeFormat('de-DE', {
  hour: '2-digit',
  minute: '2-digit',
});

function dateFromDayKey(dayKey: string): Date {
  const [year, month, day] = dayKey.split('-').map(Number);
  return new Date(year, month - 1, day);
}

function dayKeyOffset(days: number): string {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return date.toLocaleDateString('en-CA');
}

/** Above each day's entries (AK3, #701): "Heute · <Wochentag>" for today,
 * "Gestern" for yesterday, otherwise the same spelled-out German date as
 * before (issue #374). */
function formatDayHeader(dayKey: string): string {
  if (dayKey === todayKey()) return `Heute · ${WEEKDAY_LONG_FORMATTER.format(dateFromDayKey(dayKey))}`;
  if (dayKey === dayKeyOffset(-1)) return 'Gestern';
  return DAY_DATE_FORMATTER.format(dateFromDayKey(dayKey));
}

function formatEntryTime(createdAt: string): string {
  return ENTRY_TIME_FORMATTER.format(new Date(createdAt));
}

interface DayRowGroup {
  dayKey: string;
  rows: ListPresenceRow<JournalSearchEntry>[];
}

/** Groups the flat, presence-tracked row list back into per-day sections for
 * rendering — the flat shape is what `useListPresence` needs (a single stable
 * array), the grouped shape is what AK3's day headers need. Entries of the
 * same day stay contiguous because `useJournalEntries` already delivers them
 * that way and `useListPresence` only ever inserts a new row next to its
 * neighbours in that same order. */
function groupRowsByDay(rows: ListPresenceRow<JournalSearchEntry>[]): DayRowGroup[] {
  const groups: DayRowGroup[] = [];
  for (const row of rows) {
    const dayKey = row.item.entryDate;
    const last = groups[groups.length - 1];
    if (last && last.dayKey === dayKey) {
      last.rows.push(row);
    } else {
      groups.push({ dayKey, rows: [row] });
    }
  }
  return groups;
}

/**
 * The entry stream (issue #376, restructured in #701/#700 T1 into a FAB +
 * create sheet): every entry, grouped by day (AK3), newest day and newest
 * entry within a day first. Every write goes through the outbox
 * (`appendJournalEntry` → `writeJournalEntry`), never a direct API call
 * (CLAUDE.md rule 8).
 */
export function JournalEditor() {
  const [sheetOpen, setSheetOpen] = useState(false);
  // Der Suchmodus lebt seit issue #700 (AK5) im Modul-Store, geöffnet von der
  // Lupe in der Titelzeile — nicht mehr als lokaler State hier.
  const { active: searchActive } = useJournalSearchMode();
  const containerRef = useRef<HTMLDivElement>(null);
  // A ref, not state (#700 AK6, T2 jump from a search hit): scrolling to the
  // target once the stream reappears is a one-off DOM effect, not something
  // that should itself cause a render.
  const pendingScrollRef = useRef<string | null>(null);
  const dayGroups = useJournalEntries();
  const flatEntries = useMemo(() => dayGroups?.flatMap((group) => group.entries) ?? [], [dayGroups]);
  const entryRows = useListPresence(flatEntries, (entry) => entry.id);
  const dayRowGroups = groupRowsByDay(entryRows);

  function handleSearchSelect(entryDate: string) {
    pendingScrollRef.current = entryDate;
  }

  // The stream shows every day at once now, so "select a day" means scrolling
  // to its already-rendered group rather than swapping which day is visible.
  // The target only exists once `searchActive` has flipped back to false —
  // `JournalSearch.handleSelect` closes the search mode (store) in the same
  // handler that calls `onSelect`, a render before this effect runs — so this
  // waits for that flip.
  useEffect(() => {
    if (searchActive || !pendingScrollRef.current) return;
    const target = containerRef.current?.querySelector<HTMLElement>(
      `[data-day="${pendingScrollRef.current}"]`,
    );
    target?.scrollIntoView({ block: 'start' });
    pendingScrollRef.current = null;
  }, [searchActive]);

  async function handleDelete(id: string) {
    await deleteJournalEntry(id);
  }

  return (
    <>
      <JournalSearch onSelect={handleSearchSelect} />
      <div className="journal-editor" ref={containerRef}>
        {!searchActive && (
          <>
            <JournalOrphanedKeyCard />
            {/* Same convention as habit-table.tsx/task-list.tsx's `__empty` text. Without
                it, a fresh account renders `.journal-editor` with zero children — the
                form used to live directly in this div and kept it non-collapsed, #701
                moved it into the sheet, so an explicit empty state is what keeps this
                div visible (issue #646 AC1's "bleibt sichtbar" offline note). */}
            {dayGroups !== undefined && dayRowGroups.length === 0 && (
              <p className="journal-editor__empty">Noch keine Einträge. Leg deinen ersten an.</p>
            )}
            {dayRowGroups.map((group) => (
              <section key={group.dayKey} className="journal-editor__day-group" data-day={group.dayKey}>
                <h2 className="journal-editor__day-header">{formatDayHeader(group.dayKey)}</h2>
                <ul className="journal-editor__entries">
                  {group.rows.map((row) => (
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
              </section>
            ))}
          </>
        )}
      </div>
      {!searchActive && <Fab label={JOURNAL_ENTRY_SHEET_LABEL} text="Eintrag" onClick={() => setSheetOpen(true)} />}
      <JournalEntrySheet open={sheetOpen} onClose={() => setSheetOpen(false)} />
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
  entry: JournalSearchEntry;
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
        {entry.mood && <span className="journal-editor__entry-mood">Stimmung {entry.mood}/10</span>}
        <button
          type="button"
          className="journal-editor__entry-delete"
          aria-label="Eintrag löschen"
          onClick={() => onDelete(entry.id)}
        >
          Löschen
        </button>
      </div>
      {entry.text && <p className="journal-editor__entry-text">{entry.text}</p>}
      {entry.tags.length > 0 && (
        <div className="journal-editor__entry-tags">
          {entry.tags.map((tag) => (
            <span key={tag} className="journal-editor__entry-tag">
              {tag}
            </span>
          ))}
        </div>
      )}
    </li>
  );
}
