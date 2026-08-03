'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { mutate } from '@/local/outbox';
import { SegmentedControl } from '@/ui/segmented-control';
import { Sheet } from '@/ui/sheet';
import type { HabitSchedule, HabitView } from './use-habits';

const CREATE_LABEL = 'Gewohnheit anlegen';
const EDIT_LABEL = 'Gewohnheit bearbeiten';

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

/**
 * The "kleine Token-Palette" from issue #102: the four area colours already
 * audited for contrast and dark mode (docs/DESIGN_SYSTEM.md), not a new set of
 * one-off habit colours. `''` is the sentinel for "no override" — `color: null`
 * on the row, which the list resolves to `--area-habits` (the AC's default).
 */
const COLORS: { value: string; token: string; label: string }[] = [
  { value: '', token: '--area-habits', label: 'Grün (Standard)' },
  { value: '--area-tasks', token: '--area-tasks', label: 'Koralle' },
  { value: '--area-events', token: '--area-events', label: 'Teal' },
  { value: '--area-journal', token: '--area-journal', label: 'Violett' },
];

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
  const [color, setColor] = useState('');
  const nameRef = useRef<HTMLInputElement>(null);
  const wasOpenRef = useRef(false);

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
      setColor(habit.color ?? '');
    }
    if (open && !wasOpenRef.current && mode === 'create') {
      setName('');
      setSchedule('daily');
      setTarget('1');
      setColor('');
    }
    wasOpenRef.current = open;
  }, [open, mode, habit]);

  // Every non-weekly period has a fixed target of 1 (issue #509) — reset it
  // right where the schedule itself changes, not in an effect (no need to
  // synchronize with anything external here, so no effect is warranted).
  function handleScheduleChange(next: HabitSchedule) {
    setSchedule(next);
    if (next !== 'weekly') setTarget('1');
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
          color: color || null,
          archivedAt: null,
          createdAt: new Date().toISOString(),
        },
      });
      return;
    }

    if (!habit) return;
    const nextColor = color || null;

    const payload: Record<string, unknown> = {};
    if (trimmedName !== habit.name) payload.name = trimmedName;
    if (schedule !== habit.schedule) payload.schedule = schedule;
    if (nextTarget !== habit.target) payload.target = nextTarget;
    if (nextColor !== habit.color) payload.color = nextColor;

    onClose();
    if (Object.keys(payload).length > 0) {
      await mutate({ table: 'habits', rowId: habit.id, op: 'upsert', payload });
    }
  }

  return (
    <Sheet
      open={open}
      onClose={onClose}
      label={mode === 'create' ? CREATE_LABEL : EDIT_LABEL}
      initialFocusRef={nameRef}
    >
      <form className="habit-editor" onSubmit={handleSubmit}>
        <input
          ref={nameRef}
          type="text"
          className="habit-editor__name"
          value={name}
          onChange={(event) => setName(event.target.value)}
          aria-label="Name"
          placeholder="z. B. Wasser trinken"
        />
        <fieldset className="habit-editor__schedules">
          <legend>Rhythmus</legend>
          {SCHEDULES.map((option) => (
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
        {schedule === 'weekly' && (
          <SegmentedControl
            options={TARGETS}
            value={target}
            onChange={setTarget}
            label="Wie oft pro Woche"
          />
        )}
        <fieldset className="habit-editor__colors">
          <legend>Farbe</legend>
          {COLORS.map((option) => (
            <label key={option.value || 'default'} className="habit-editor__color-option">
              <input
                type="radio"
                name="color"
                checked={color === option.value}
                onChange={() => setColor(option.value)}
              />
              <span
                className="habit-editor__color-swatch"
                style={{ background: `var(${option.token})` }}
                aria-hidden="true"
              />
              {option.label}
            </label>
          ))}
        </fieldset>
        <button type="submit" className="habit-editor__submit">
          {mode === 'create' ? 'Anlegen' : 'Speichern'}
        </button>
      </form>
    </Sheet>
  );
}
