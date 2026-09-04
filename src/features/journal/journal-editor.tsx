'use client';

import {
  useEffect,
  useMemo,
  useState,
  type CSSProperties,
  type FormEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { Fab } from '@/ui/fab';
import { useListPresence } from '@/ui/use-list-presence';
import { deleteJournalEntry, shiftDayKey, todayKey } from './entry';
import { JournalEntrySheet, JOURNAL_ENTRY_SHEET_LABEL } from './journal-entry-sheet';
import './journal-editor.css';
import { useJournalDayNav } from './journal-current-day';
import { JournalSearch } from './journal-search';
import { useJournalSearchMode } from './journal-view-mode';
import { useJournalLock } from './lock-store';
import { useJournalEntries } from './use-journal-entries';
import { useOrphanedKey } from './use-orphaned-key';
import type { JournalSearchEntry } from './search';

const ENTRY_TIME_FORMATTER = new Intl.DateTimeFormat('de-DE', {
  hour: '2-digit',
  minute: '2-digit',
});

function formatEntryTime(createdAt: string): string {
  return ENTRY_TIME_FORMATTER.format(new Date(createdAt));
}

const DAY_CARD_DATE_FORMATTER = new Intl.DateTimeFormat('de-DE', {
  weekday: 'long',
  day: 'numeric',
  month: 'long',
});

/** Local calendar day (not UTC), same reasoning as `entry.ts`'s `todayKey`. */
function formatDayCardDate(dateKey: string): string {
  const [year, month, day] = dateKey.split('-').map(Number);
  return DAY_CARD_DATE_FORMATTER.format(new Date(year, month - 1, day));
}

/** "Heute"/"Gestern" for the two days closest to now (same idiom as
 * `use-tasks.ts`'s `formatDayMarker`) — any older day shows no relative badge,
 * `.journal-day-card__date` already carries its full weekday/day/month. */
function relativeDayLabel(dateKey: string): string | null {
  const today = todayKey();
  if (dateKey === today) return 'Heute';
  if (dateKey === shiftDayKey(today, -1)) return 'Gestern';
  return null;
}

/** Below this, or when the vertical delta dominates, releasing is a cancelled
 * swipe (issue #1050 AK1) — mirrors task-item.tsx's/weather-day.tsx's own
 * `SWIPE_THRESHOLD_PX`. */
const SWIPE_THRESHOLD_PX = 80;

/** Movement at or below this still counts as a tap (task-item.tsx's own
 * `TAP_TOLERANCE_PX`) — the point at which the pager below claims the pointer
 * for itself, see `handlePointerMove`. */
const TAP_TOLERANCE_PX = 8;

function isTypingTarget(target: EventTarget | null): boolean {
  const tag = (target as HTMLElement | null)?.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA';
}

/**
 * The day's entry stream (issue #376, restructured in #701/#700 T1 into a FAB
 * + create sheet, then in #1048 into the "line of the day" surface, first cut
 * of #1046) collapses to today's own line — every write still goes through the
 * outbox (`appendJournalEntry` → `writeJournalEntry`), never a direct API call
 * (CLAUDE.md rule 8).
 */
export function JournalEditor() {
  const [sheetOpen, setSheetOpen] = useState(false);
  // Der Suchmodus lebt seit issue #700 (AK5) im Modul-Store, geöffnet von der
  // Lupe in der Titelzeile — nicht mehr als lokaler State hier.
  const { active: searchActive } = useJournalSearchMode();
  // Derselbe Modul-Store wie die Chevrons in der Augenbrauenzeile
  // (journal-day-nav.tsx, issue #1050) — `date` ist so mit denen immer
  // synchron, ohne Prop-Drilling durch page.tsx hindurch.
  const { date } = useJournalDayNav();
  const currentDate = date ?? todayKey();

  /** #1048: die Seite zeigt nur noch den heutigen Tag, ein Sprung zu einem
   * anderen Tag aus einem Suchtreffer existiert vorerst nicht mehr — das folgt
   * mit „Suche im neuen Register" (Kind-Ticket von #1046), das dem gezeigten
   * Tag echten Zustand gibt. Ein Treffer schließt die Suche bereits selbst
   * (journal-search.tsx), das reicht hier aus. */
  function handleSearchSelect() {}

  async function handleDelete(id: string) {
    await deleteJournalEntry(id);
  }

  return (
    <>
      <JournalSearch onSelect={handleSearchSelect} />
      <div className="journal-editor">
        {!searchActive && (
          <>
            <JournalOrphanedKeyCard />
            <JournalDayPager onOpenSheet={() => setSheetOpen(true)} onDelete={handleDelete} />
          </>
        )}
      </div>
      {!searchActive && <Fab label={JOURNAL_ENTRY_SHEET_LABEL} text="Eintrag" onClick={() => setSheetOpen(true)} />}
      <JournalEntrySheet open={sheetOpen} date={currentDate} onClose={() => setSheetOpen(false)} />
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

/**
 * Swipe/keyboard day switcher (issue #1050) — same shape as `weather-day.tsx`'s
 * `WeatherDayScreen` (issue #267): pointer handlers translate the card by
 * `dragX`, a real day change resets it without a transition (AK3, no glide on
 * the flip itself), an invalid or (forward, AK6) out-of-bounds swipe springs
 * back instead (`bouncing`). Reads `journal-current-day.ts`'s module store,
 * the same one the eyebrow's chevrons (`journal-day-nav.tsx`, outside this
 * subtree) read and write — a swipe here and a chevron tap there change the
 * very same day. The page's own header (Augenbraue/h1/Figur) lives entirely
 * outside this component, in `page.tsx`, so it is untouched by the transform
 * for free — nothing here needs to special-case it (AK3).
 */
function JournalDayPager({
  onOpenSheet,
  onDelete,
}: {
  onOpenSheet: () => void;
  onDelete: (id: string) => void;
}) {
  const { date, nextDate, previousDate, goTo } = useJournalDayNav();
  const [startX, setStartX] = useState<number | null>(null);
  const [startY, setStartY] = useState<number | null>(null);
  const [dragX, setDragX] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [bouncing, setBouncing] = useState(false);

  // AK5: dieselbe Zuordnung wie die Chevrons — ArrowLeft wie der linke
  // ("Vorheriger Tag"), ArrowRight wie der rechte ("Nächster Tag"). Ignoriert,
  // solange irgendwo getippt wird (Eintrag-Sheet, Suche), damit ein Cursor-Move
  // im Textfeld nicht nebenbei den Tag wechselt (Muster wie quick-add.tsx's
  // eigener `isTypingTarget`-Guard).
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
      if (isTypingTarget(event.target)) return;
      const target = event.key === 'ArrowLeft' ? previousDate : nextDate;
      if (!target) return;
      event.preventDefault();
      goTo(target);
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [nextDate, previousDate, goTo]);

  /**
   * Capture is deferred to the first real move (`handlePointerMove`), not
   * taken here — the empty day's own card is itself a tappable `<button>`
   * (AK3, #1048), and capturing immediately would steal the native click the
   * browser is about to synthesize for a plain tap on it, same reasoning as
   * task-item.tsx's checkbox exclusion. A plain tap on that button, or on the
   * card's own "Löschen"/"N weitere Notizen" buttons, is thus untouched by
   * this handler entirely; only a real drag ever claims the pointer.
   */
  function handlePointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    setStartX(event.clientX);
    setStartY(event.clientY);
    setDragging(true);
    setBouncing(false);
  }

  function handlePointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    if (!dragging || startX === null) return;
    const deltaX = event.clientX - startX;
    if (!event.currentTarget.hasPointerCapture(event.pointerId) && Math.abs(deltaX) > TAP_TOLERANCE_PX) {
      event.currentTarget.setPointerCapture(event.pointerId);
    }
    setDragX(deltaX);
  }

  function endDrag(event: ReactPointerEvent<HTMLDivElement>) {
    if (!dragging) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    const deltaX = startX === null ? 0 : event.clientX - startX;
    const deltaY = startY === null ? 0 : event.clientY - startY;
    setDragging(false);
    setStartX(null);
    setStartY(null);
    setDragX(0);

    // Too short, or mostly vertical (AK1) — both leave the day unchanged.
    const isSwipe = Math.abs(deltaX) > SWIPE_THRESHOLD_PX && Math.abs(deltaX) > Math.abs(deltaY);
    const target = isSwipe ? (deltaX < 0 ? nextDate : previousDate) : null;

    if (target) {
      // A real day change is instant, never a glide (AK3) — `dragX` above
      // already reset to 0 without ever turning `bouncing` on.
      goTo(target);
    } else {
      // Invalid swipe, or the forward edge at today (AK6) — spring back.
      setBouncing(true);
    }
  }

  /** The browser took the gesture over (e.g. a real vertical scroll) — nothing
   * to undo visually, same reasoning as task-item.tsx's own `cancelDrag`. */
  function cancelDrag(event: ReactPointerEvent<HTMLDivElement>) {
    if (!dragging) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    setDragging(false);
    setStartX(null);
    setStartY(null);
    setDragX(0);
  }

  return (
    <div
      className="journal-day-pager"
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={endDrag}
      onPointerCancel={cancelDrag}
    >
      <div
        className={'journal-day-pager__track' + (bouncing ? ' journal-day-pager__track--bouncing' : '')}
        style={dragX ? { transform: `translateX(${dragX}px)` } : undefined}
        onTransitionEnd={() => setBouncing(false)}
      >
        <JournalDayCard date={date ?? todayKey()} onOpenSheet={onOpenSheet} onDelete={onDelete} />
      </div>
    </div>
  );
}

/**
 * The one surface for a given day (AK1–AK4, #1048; generalized to any day in
 * #1050): eyebrow „Heute"/"Gestern" (older days: none, the date line already
 * carries the full weekday) + the long date, then either the day's line — the
 * *first* entry created that day (AK2's "N weitere Notizen" covers the rest)
 * — or, with nothing written yet, a dashed empty invitation (AK3).
 * `useJournalEntries()` already re-groups on every `journal_entries` change
 * (same session-cache source search reads from), so no extra decrypt path is
 * added here.
 */
function JournalDayCard({
  date,
  onOpenSheet,
  onDelete,
}: {
  date: string;
  onOpenSheet: () => void;
  onDelete: (id: string) => void;
}) {
  const dayGroups = useJournalEntries();
  // Neuestes zuerst (useJournalEntries) — die Zeile des Tages ist der zuerst
  // angelegte Eintrag (createdAt aufsteigend), also der letzte in dieser Liste.
  const dayEntries = useMemo(
    () => dayGroups?.find((group) => group.dayKey === date)?.entries ?? [],
    [dayGroups, date],
  );
  const headline = dayEntries.length > 0 ? dayEntries[dayEntries.length - 1] : undefined;
  const rest = useMemo(() => dayEntries.slice(0, -1), [dayEntries]);
  const [expanded, setExpanded] = useState(false);
  const restRows = useListPresence(rest, (entry) => entry.id);
  const eyebrow = relativeDayLabel(date);
  const dateLabel = formatDayCardDate(date);

  // Kein Ladezustand (Produktprinzip, wie der bisherige Editor) — vor dem
  // ersten liveQuery-Ergebnis wird nichts gerendert.
  if (dayGroups === undefined) return null;

  if (!headline) {
    return (
      <button type="button" className="journal-day-card journal-day-card--empty" onClick={onOpenSheet}>
        <div className="journal-day-card__heading">
          {eyebrow && <p className="journal-day-card__eyebrow">{eyebrow}</p>}
          <p className="journal-day-card__date">{dateLabel}</p>
        </div>
        <p className="journal-day-card__placeholder">Deine Zeile für heute</p>
      </button>
    );
  }

  return (
    <section className="journal-day-card">
      <div className="journal-day-card__header">
        <div className="journal-day-card__heading">
          {eyebrow && <p className="journal-day-card__eyebrow">{eyebrow}</p>}
          <p className="journal-day-card__date">{dateLabel}</p>
        </div>
        {headline.mood && (
          <span
            className="journal-day-card__mood"
            style={{ '--mood': headline.mood } as CSSProperties}
            aria-label={`Stimmung ${headline.mood}/10`}
          >
            {headline.mood}
          </span>
        )}
      </div>
      {headline.text && <p className="journal-day-card__line">{headline.text}</p>}
      <div className="journal-day-card__footer">
        {rest.length > 0 && (
          <button
            type="button"
            className="journal-day-card__more"
            aria-expanded={expanded}
            aria-controls="journal-day-card-more"
            onClick={() => setExpanded((current) => !current)}
          >
            {rest.length === 1 ? '1 weitere Notiz' : `${rest.length} weitere Notizen`}
          </button>
        )}
        <button
          type="button"
          className="journal-day-card__delete"
          aria-label="Eintrag löschen"
          onClick={() => onDelete(headline.id)}
        >
          Löschen
        </button>
      </div>
      {expanded && restRows.length > 0 && (
        // `restRows.length`, not `rest.length`: a row mid-exit-animation is
        // already gone from `rest` (the live-query-derived source), but must
        // stay mounted in the DOM until `settlePresenceEntry` drops it after
        // `onAnimationEnd` — gating on `rest` instead would unmount the last
        // remaining row (and the whole panel with it) before its `list-exit`
        // animation ever gets to play.
        <ul id="journal-day-card-more" className="journal-editor__entries">
          {restRows.map((row) => (
            <JournalEntryRow
              key={row.key}
              entry={row.item}
              onDelete={onDelete}
              entering={row.status === 'entering'}
              leaving={row.status === 'leaving'}
              onAnimationEnd={row.onAnimationEnd}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

/** One entry in the "N weitere Notizen" panel (AK2): time, mood (if set), text,
 * tags, and the existing delete path — mood and tags belong to this one entry,
 * not the day. */
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
