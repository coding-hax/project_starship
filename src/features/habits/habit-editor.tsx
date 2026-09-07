'use client';

import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { JOURNAL_HABIT_ID } from '@/features/journal/journal-habit';
import { mutate } from '@/local/outbox';
import { Chip } from '@/ui/chip';
import { EMOJI_PALETTE } from '@/ui/emoji-palette';
import { SegmentedControl } from '@/ui/segmented-control';
import { Sheet } from '@/ui/sheet';
import type { HabitSchedule, HabitView } from './use-habits';

const CREATE_LABEL = 'Routine anlegen';
const EDIT_LABEL = 'Routine bearbeiten';

/**
 * A vertical radio fieldset, not `SegmentedControl` (issue #509): six labels —
 * Täglich/Wöchentlich/Alle zwei Wochen/Monatlich/Quartalsweise/Jährlich — don't
 * fit a single segmented row at 375px. `custom` is left out: it has no UI yet
 * (schema.ts), reserved for a later milestone.
 */
const SCHEDULES: { value: HabitSchedule; label: string }[] = [
  { value: 'daily', label: 'Täglich' },
  { value: 'weekly', label: 'Wöchentlich' },
  { value: 'biweekly', label: 'Alle zwei Wochen' },
  { value: 'monthly', label: 'Monatlich' },
  { value: 'quarterly', label: 'Quartalsweise' },
  { value: 'yearly', label: 'Jährlich' },
];

/** 1–6× pro Woche (issue #509 Owner-Entsch. 1) — "täglich" stays its own schedule, not "7×". */
const TARGETS: { value: '1' | '2' | '3' | '4' | '5' | '6'; label: string }[] = [
  { value: '1', label: '1' },
  { value: '2', label: '2' },
  { value: '3', label: '3' },
  { value: '4', label: '4' },
  { value: '5', label: '5' },
  { value: '6', label: '6' },
];

/** Which chip's panel is open — at most one at a time (issue #711 AK3). */
type ChipKey = 'rhythmus' | 'ziel' | 'emoji';

export interface HabitEditorProps {
  open: boolean;
  mode: 'create' | 'edit';
  /** Required for `mode: 'edit'` — ignored for `mode: 'create'`. */
  habit: HabitView | null;
  onClose: () => void;
}

/**
 * Create and edit share one sheet — unlike tasks, a habit has no freetext quick-add
 * (issue #102 scope is a small management screen, not a capture flow), so there is
 * no separate lightweight path worth splitting out.
 */
export function HabitEditor({ open, mode, habit, onClose }: HabitEditorProps) {
  const [name, setName] = useState('');
  const [schedule, setSchedule] = useState<HabitSchedule>('daily');
  const [target, setTarget] = useState<'1' | '2' | '3' | '4' | '5' | '6'>('1');
  const [emoji, setEmoji] = useState('');
  const [openChip, setOpenChip] = useState<ChipKey | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const wasOpenRef = useRef(false);
  // Unique per mounted instance (not a module-level constant): habit-table.tsx and
  // add-habit-fab.tsx each mount their own HabitEditor at the same time (edit resp.
  // create), so a shared id would duplicate the `<form id>` the header's action
  // button targets via the HTML `form` attribute — the browser's form-owner lookup
  // then silently binds to whichever instance happens to come first in the DOM.
  const formId = useId();
  /** The Journal habit's name and emoji are fixed (issue #505 AC3, #1101 AC9) —
   * only its rhythm can be changed here. */
  const isJournal = mode === 'edit' && habit?.id === JOURNAL_HABIT_ID;

  // Load values exactly once, on the closed->open transition — not on every
  // re-render, or a live-query update elsewhere would overwrite mid-typing input.
  useEffect(() => {
    if (open && !wasOpenRef.current && mode === 'edit' && habit) {
      setName(habit.name);
      setSchedule(habit.schedule === 'custom' ? 'daily' : habit.schedule);
      setTarget(
        habit.schedule === 'weekly' && habit.target >= 1 && habit.target <= 6
          ? (String(habit.target) as '1' | '2' | '3' | '4' | '5' | '6')
          : '1',
      );
      setEmoji(habit.emoji ?? '');
      setOpenChip(null);
    }
    if (open && !wasOpenRef.current && mode === 'create') {
      setName('');
      setSchedule('daily');
      setTarget('1');
      setEmoji('');
      setOpenChip(null);
    }
    wasOpenRef.current = open;
  }, [open, mode, habit]);

  // Every non-weekly period has a fixed target of 1 (issue #509) — reset it
  // right where the schedule itself changes, not in an effect (no need to
  // synchronize with anything external here, so no effect is warranted).
  function handleScheduleChange(next: HabitSchedule) {
    setSchedule(next);
    if (next !== 'weekly') {
      setTarget('1');
      // The Ziel-chip disappears with the schedule that gates it (AK2) — its
      // panel would otherwise keep rendering in the slot for a chip that is
      // no longer there.
      setOpenChip((current) => (current === 'ziel' ? null : current));
    }
  }

  function toggleChip(key: ChipKey) {
    setOpenChip((current) => (current === key ? null : key));
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const trimmedName = name.trim();
    if (!trimmedName) {
      nameRef.current?.focus();
      return;
    }

    const nextTarget = schedule === 'weekly' ? Number(target) : 1;

    if (mode === 'create') {
      onClose();
      await mutate({
        table: 'habits',
        op: 'upsert',
        payload: {
          name: trimmedName,
          schedule,
          target: nextTarget,
          emoji: emoji || null,
          archivedAt: null,
          createdAt: new Date().toISOString(),
        },
      });
      return;
    }

    if (!habit) return;

    const payload: Record<string, unknown> = {};
    if (schedule !== habit.schedule) payload.schedule = schedule;
    // The Journal habit has no name/emoji/target inputs (issue #505 AC3, #1101
    // AC9) — only its rhythm is diffed, never the fixed fields.
    if (!isJournal) {
      const nextEmoji = emoji || null;
      if (trimmedName !== habit.name) payload.name = trimmedName;
      if (nextEmoji !== habit.emoji) payload.emoji = nextEmoji;
      if (nextTarget !== habit.target) payload.target = nextTarget;
    }

    onClose();
    if (Object.keys(payload).length > 0) {
      await mutate({ table: 'habits', rowId: habit.id, op: 'upsert', payload });
    }
  }

  const scheduleLabel = SCHEDULES.find((option) => option.value === schedule)!.label;
  const showZielChip = !isJournal && schedule === 'weekly';
  const showEmojiChip = !isJournal;

  return (
    <Sheet
      open={open}
      onClose={onClose}
      label={mode === 'create' ? CREATE_LABEL : EDIT_LABEL}
      initialFocusRef={nameRef}
      header={{ actionLabel: mode === 'create' ? 'Anlegen' : 'Sichern', formId }}
    >
      <form id={formId} className="habit-editor" onSubmit={handleSubmit}>
        {!isJournal && (
          <input
            ref={nameRef}
            type="text"
            className="habit-editor__name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            aria-label="Name"
            placeholder="z. B. Wasser trinken"
          />
        )}
        <div className="habit-editor__chips">
          <Chip
            field="Rhythmus"
            emptyLabel="Rhythmus?"
            value={scheduleLabel}
            open={openChip === 'rhythmus'}
            panelId="habit-panel-rhythmus"
            onOpen={() => toggleChip('rhythmus')}
          />
          {showZielChip && (
            <Chip
              field="Ziel"
              emptyLabel="Wie oft?"
              value={`${target}×`}
              open={openChip === 'ziel'}
              panelId="habit-panel-ziel"
              onOpen={() => toggleChip('ziel')}
            />
          )}
          {showEmojiChip && (
            <Chip
              field="Emoji"
              emptyLabel="Emoji?"
              value={emoji || 'Kein Emoji'}
              open={openChip === 'emoji'}
              panelId="habit-panel-emoji"
              onOpen={() => toggleChip('emoji')}
            />
          )}
        </div>
        {/* Gated on `open` for the same reason the quick-add panel-slot is
            (issue #711 AK5): a closed <dialog> keeps its children in the DOM,
            and the Schedule-/Emoji-Optionen would otherwise sit in it as real
            text nodes, matching every page-wide text query twice. */}
        {open && (
          <div className="habit-editor__panel-slot" id={`habit-panel-${openChip ?? 'none'}`}>
            {openChip === 'rhythmus' && (
              <fieldset className="habit-editor__schedules">
                <legend>Rhythmus</legend>
                {/* The Journal habit is restricted to daily/weekly (issue #505 AC3);
                    every other habit gets the full set of periods (issue #509). */}
                {(isJournal ? SCHEDULES.slice(0, 2) : SCHEDULES).map((option) => (
                  <label key={option.value} className="habit-editor__schedule-option">
                    <input
                      type="radio"
                      name="schedule"
                      checked={schedule === option.value}
                      aria-checked={schedule === option.value}
                      onChange={() => handleScheduleChange(option.value)}
                      // A radio input's default focus-on-activation happens as part of
                      // `mousedown` (not `pointerdown`) — next to the name field (#138)
                      // that steals focus mid-typing. Suppressing `mousedown`'s default
                      // leaves focus wherever it already was; the checked-toggle is part
                      // of `click`'s own activation behaviour, so `onChange` still fires.
                      onMouseDown={(event) => event.preventDefault()}
                    />
                    {option.label}
                  </label>
                ))}
              </fieldset>
            )}
            {openChip === 'ziel' && showZielChip && (
              <SegmentedControl
                options={TARGETS}
                value={target}
                onChange={setTarget}
                label="Wie oft pro Woche"
              />
            )}
            {openChip === 'emoji' && showEmojiChip && (
              <fieldset className="habit-editor__emojis">
                <legend>Emoji</legend>
                <div className="habit-editor__emoji-scroll">
                  <label className="habit-editor__emoji-none">
                    <input
                      type="radio"
                      name="emoji"
                      checked={emoji === ''}
                      onChange={() => setEmoji('')}
                    />
                    Kein Emoji
                  </label>
                  {EMOJI_PALETTE.map((group) => (
                    <div key={group.heading} className="habit-editor__emoji-group">
                      <h3 className="habit-editor__emoji-heading">{group.heading}</h3>
                      <div className="habit-editor__emoji-grid">
                        {group.emojis.map((option) => (
                          <label key={option.emoji} className="habit-editor__emoji-option">
                            <input
                              type="radio"
                              name="emoji"
                              aria-label={option.label}
                              checked={emoji === option.emoji}
                              onChange={() => setEmoji(option.emoji)}
                            />
                            <span className="habit-editor__emoji-glyph" aria-hidden="true">
                              {option.emoji}
                            </span>
                          </label>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              </fieldset>
            )}
          </div>
        )}
      </form>
    </Sheet>
  );
}
