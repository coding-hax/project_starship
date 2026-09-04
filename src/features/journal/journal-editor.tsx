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
import { formatYearCount, formatYearsAgo, sameDayEntries } from './same-day';
import { useJournalEntries, type JournalDayGroup } from './use-journal-entries';
import { useJournalSearchEntries } from './use-journal-search-entries';
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

const DAY_SHORT_FORMATTER = new Intl.DateTimeFormat('de-DE', { day: 'numeric', month: 'long' });

/** Local calendar day from a `YYYY-MM-DD` key, not UTC — same reasoning as
 * `same-day.ts`'s day matching and `journal-search.tsx`'s `formatEntryDate`. */
function parseDayKey(dayKey: string): Date {
  const [year, month, day] = dayKey.split('-').map(Number);
  return new Date(year, month - 1, day);
}

/** Local calendar day (not UTC), same reasoning as `entry.ts`'s `todayKey`. */
function formatDayCardDate(dayKey: string): string {
  return DAY_CARD_DATE_FORMATTER.format(parseDayKey(dayKey));
}

/** Short form for a "Zuletzt geschrieben" row (AK2, #1052) — day + month, no
 * year: the list only ever holds recent days, never a different year. */
function formatDayKeyShort(dayKey: string): string {
  return DAY_SHORT_FORMATTER.format(parseDayKey(dayKey));
}

/** "Heute"/"Gestern" for the two days closest to now (same idiom as
 * `use-tasks.ts`'s `formatDayMarker`) — any older day shows no relative badge,
 * `.journal-day-card__date` already carries its full weekday/day/month. */
function relativeDayLabel(dayKey: string): string | null {
  const today = todayKey();
  if (dayKey === today) return 'Heute';
  if (dayKey === shiftDayKey(today, -1)) return 'Gestern';
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
  // Ein Hook-Aufruf für beide Verbraucher (issue #1049 AK6): die Suche
  // (journal-search.tsx) und „An diesem Tag" lesen denselben Sitzungs-Cache
  // statt je einen eigenen liveQuery/Entschlüsselungslauf zu starten. Läuft
  // unabhängig vom Suchmodus, damit dessen Öffnen ohne Ladepause Treffer zeigt.
  const searchEntries = useJournalSearchEntries();
  // Hochgezogen (issue #1052 AK2), damit sowohl die Tageskarte als auch
  // „Zuletzt geschrieben" denselben liveQuery/Entschlüsselungslauf teilen
  // statt je einen eigenen zu starten (dieselbe Begründung wie searchEntries).
  const dayGroups = useJournalEntries();
  // Derselbe Modul-Store wie die Chevrons in der Augenbrauenzeile
  // (journal-day-nav.tsx) und das Wischen (JournalDayPager unten, issue
  // #1050) — „Zuletzt geschrieben" (issue #1052 AK2) ist ein dritter
  // Schreiber desselben Stores, kein eigener State: eine Zeile dort, ein
  // Chevron und ein Wisch ändern denselben gezeigten Tag, ohne Prop-Drilling
  // durch page.tsx hindurch.
  const { date, goTo } = useJournalDayNav();
  const shownDay = date ?? todayKey();

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
      <JournalSearch entries={searchEntries} onSelect={handleSearchSelect} />
      <div className="journal-editor">
        {!searchActive && (
          <>
            <JournalOrphanedKeyCard />
            <JournalDayPager
              dayGroups={dayGroups}
              entries={searchEntries}
              onOpenSheet={() => setSheetOpen(true)}
              onDelete={handleDelete}
            />
            <JournalRecent dayGroups={dayGroups} shownDay={shownDay} onShowDay={goTo} />
          </>
        )}
      </div>
      {!searchActive && <Fab label={JOURNAL_ENTRY_SHEET_LABEL} text="Eintrag" onClick={() => setSheetOpen(true)} />}
      <JournalEntrySheet open={sheetOpen} date={shownDay} onClose={() => setSheetOpen(false)} />
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
 * subtree) and „Zuletzt geschrieben"'s rows (`JournalRecent`, issue #1052 AK2)
 * read/write — a swipe here, a chevron tap, or a row click there all change
 * the very same day. The page's own header (Augenbraue/h1/Figur) lives
 * entirely outside this component, in `page.tsx`, so it is untouched by the
 * transform for free — nothing here needs to special-case it (AK3).
 *
 * `dayGroups` is threaded through from `JournalEditor` (issue #1052 AK2,
 * shared with `JournalRecent`) instead of queried again here. On desktop
 * (journal-editor.css 768px block) this wrapper and its `__track` collapse
 * via `display: contents`, so `JournalDayCard`/`JournalSameDay` land as
 * direct grid items of `.journal-editor` — the swipe machinery stays mounted
 * (harmless: #1052 AK2 says nobody swipes on desktop) but contributes no box
 * of its own to the two-column grid.
 */
function JournalDayPager({
  dayGroups,
  entries,
  onOpenSheet,
  onDelete,
}: {
  dayGroups: JournalDayGroup[] | undefined;
  entries: JournalSearchEntry[] | undefined;
  onOpenSheet: () => void;
  onDelete: (id: string) => void;
}) {
  const { date, nextDate, previousDate, goTo } = useJournalDayNav();
  const currentDate = date ?? todayKey();
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
        <JournalDayCard dayGroups={dayGroups} dayKey={currentDate} onOpenSheet={onOpenSheet} onDelete={onDelete} />
        <JournalSameDay entries={entries} dayKey={currentDate} />
      </div>
    </div>
  );
}

/**
 * The one surface for the shown day (AK1–AK4, #1048; generalized to any day
 * in #1050's Wischen/Chevrons/Pfeiltasten, and reachable from #1052 AK2's
 * „Zuletzt geschrieben" — default remains „heute"): eyebrow „Heute"/„Gestern"
 * (older days: none, the date line already carries the full weekday) + the
 * long date, then either the day's line — the *first* entry created that day
 * (AK2's "N weitere Notizen" covers the rest) — or, with nothing written yet,
 * a dashed empty invitation (AK3, #1048). `dayGroups` comes from
 * `useJournalEntries()` lifted in `journal-editor.tsx` (issue #1052 AK2), so
 * this card and „Zuletzt geschrieben" share one liveQuery/Entschlüsselungslauf
 * instead of each starting its own.
 */
function JournalDayCard({
  dayGroups,
  dayKey,
  onOpenSheet,
  onDelete,
}: {
  dayGroups: JournalDayGroup[] | undefined;
  dayKey: string;
  onOpenSheet: () => void;
  onDelete: (id: string) => void;
}) {
  // Neuestes zuerst (useJournalEntries) — die Zeile des Tages ist der zuerst
  // angelegte Eintrag (createdAt aufsteigend), also der letzte in dieser Liste.
  const dayEntries = useMemo(
    () => dayGroups?.find((group) => group.dayKey === dayKey)?.entries ?? [],
    [dayGroups, dayKey],
  );
  const headline = dayEntries.length > 0 ? dayEntries[dayEntries.length - 1] : undefined;
  const rest = useMemo(() => dayEntries.slice(0, -1), [dayEntries]);
  const [expanded, setExpanded] = useState(false);
  const restRows = useListPresence(rest, (entry) => entry.id);
  const eyebrow = relativeDayLabel(dayKey);
  const dateLabel = formatDayCardDate(dayKey);

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

/** Nicht aus einem Akzeptanzkriterium abgeleitet, nur eine sinnvolle Grenze:
 * ein persönliches Journal, jahrelang täglich geführt, soll die linke Bahn
 * nicht endlos wachsen lassen (issue #1052 AK2). */
const RECENT_DAYS_LIMIT = 7;

/**
 * „Zuletzt geschrieben" (issue #1052 AK2, nur Desktop ab 768px — journal-
 * editor.css versteckt `.journal-recent` mobil): die letzten Tage mit
 * mindestens einem Eintrag, außer dem gerade gezeigten. Eine Zeile öffnet
 * diesen Tag über denselben Modul-Store wie Chevrons und Wischen (issue
 * #1050) — der Ersatz für das Wischen, das es hier (am Desktop) so nicht
 * gibt. Ganz weg ohne andere Tage (gleiches Muster wie `JournalSameDay`), kein
 * leerer Rahmen. Liest `dayGroups`, dieselbe von `JournalEditor` hochgezogene
 * Quelle wie die Tageskarte — kein eigener Entschlüsselungslauf.
 */
function JournalRecent({
  dayGroups,
  shownDay,
  onShowDay,
}: {
  dayGroups: JournalDayGroup[] | undefined;
  shownDay: string;
  onShowDay: (dayKey: string) => void;
}) {
  const days = useMemo(() => {
    if (!dayGroups) return [];
    // dayGroups ist bereits neuestes Datum zuerst sortiert (use-journal-entries.ts).
    return dayGroups
      .filter((group) => group.dayKey !== shownDay)
      .slice(0, RECENT_DAYS_LIMIT)
      .map((group) => ({ dayKey: group.dayKey, headline: group.entries[group.entries.length - 1] }));
  }, [dayGroups, shownDay]);

  if (days.length === 0) return null;

  return (
    <section className="journal-recent">
      <p className="journal-recent__eyebrow">Zuletzt geschrieben</p>
      <ul className="journal-recent__list">
        {days.map((day) => (
          <li key={day.dayKey}>
            <button type="button" className="journal-recent__row" onClick={() => onShowDay(day.dayKey)}>
              <span className="journal-recent__date">{formatDayKeyShort(day.dayKey)}</span>
              {day.headline.text && <span className="journal-recent__line">{day.headline.text}</span>}
              {day.headline.mood && (
                <span
                  className="journal-recent__mood"
                  style={{ '--mood': day.headline.mood } as CSSProperties}
                  aria-label={`Stimmung ${day.headline.mood}/10`}
                >
                  {day.headline.mood}
                </span>
              )}
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * „An diesem Tag" (issue #1049, Teil von #1046): jeder andere Jahrgang mit
 * einem Eintrag am selben Monat+Tag wie `dayKey` — generalized to any shown
 * day in #1050 (Chevrons/Wischen) and #1052 AK2 („Zuletzt geschrieben"),
 * default weiterhin „heute", unter der Zeile des Tages. Ganz weg, solange
 * kein anderes Jahr etwas beiträgt (AK5) — kein leerer Rahmen. Liest denselben
 * Sitzungs-Cache wie die Suche (`searchEntries`, hochgezogen in
 * `JournalEditor`, AK6), startet also keinen eigenen Entschlüsselungslauf.
 * `date` ist seit #1050 der gezeigte Tag, nicht mehr fest „heute" — dieselbe
 * Verallgemeinerung wie bei `JournalDayCard`.
 */
function JournalSameDay({ entries, dayKey }: { entries: JournalSearchEntry[] | undefined; dayKey: string }) {
  const years = useMemo(() => (entries ? sameDayEntries(entries, dayKey) : []), [entries, dayKey]);

  if (years.length === 0) return null;

  return (
    <section className="journal-same-day">
      <div className="journal-same-day__heading">
        <p className="journal-same-day__eyebrow">An diesem Tag</p>
        <p className="journal-same-day__count">{formatYearCount(years.length)}</p>
      </div>
      <ul className="journal-same-day__list">
        {years.map((year) => (
          <li key={year.year} className="journal-same-day__row">
            <div className="journal-same-day__row-header">
              <span className="journal-same-day__year">{year.year}</span>
              <span className="journal-same-day__distance">{formatYearsAgo(year.yearsAgo)}</span>
              {year.entry.mood && (
                <span
                  className="journal-same-day__mood"
                  style={{ '--mood': year.entry.mood } as CSSProperties}
                  aria-label={`Stimmung ${year.entry.mood}/10`}
                >
                  {year.entry.mood}
                </span>
              )}
            </div>
            {year.entry.text && <p className="journal-same-day__line">{year.entry.text}</p>}
          </li>
        ))}
      </ul>
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
