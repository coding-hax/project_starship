'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { mutate } from '@/local/outbox';
import { SegmentedControl } from '@/ui/segmented-control';
import { Sheet } from '@/ui/sheet';
import type { HabitView } from './use-habits';

const CREATE_LABEL = 'Gewohnheit anlegen';
const EDIT_LABEL = 'Gewohnheit bearbeiten';

const SCHEDULES: { value: 'daily' | 'weekly'; label: string }[] = [
  { value: 'daily', label: 'Täglich' },
  { value: 'weekly', label: 'Wöchentlich' },
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
  const [schedule, setSchedule] = useState<'daily' | 'weekly'>('daily');
  const [color, setColor] = useState('');
  const nameRef = useRef<HTMLInputElement>(null);
  const wasOpenRef = useRef(false);

  // Load values exactly once, on the closed->open transition — not on every
  // re-render, or a live-query update elsewhere would overwrite mid-typing input.
  useEffect(() => {
    if (open && !wasOpenRef.current) {
      if (mode === 'edit' && habit) {
        setName(habit.name);
        setSchedule(habit.schedule === 'weekly' ? 'weekly' : 'daily');
        setColor(habit.color ?? '');
      } else {
        setName('');
        setSchedule('daily');
        setColor('');
      }
    }
    wasOpenRef.current = open;
  }, [open, mode, habit]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const trimmedName = name.trim();
    if (!trimmedName) {
      nameRef.current?.focus();
      return;
    }

    if (mode === 'create') {
      onClose();
      await mutate({
        table: 'habits',
        op: 'upsert',
        payload: {
          name: trimmedName,
          schedule,
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
        <SegmentedControl
          options={SCHEDULES}
          value={schedule}
          onChange={setSchedule}
          label="Rhythmus"
        />
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
