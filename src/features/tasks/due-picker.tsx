'use client';

import { useEffect, useRef, useState } from 'react';
import { addDays, addMonthsClamped, formatMonthTitle, monthDaysFor, weekDaysFor } from '@/features/events/event-time';
import { IconChevronLeft, IconChevronRight } from '@/ui/icons';
import { isoToLocalInput } from './datetime-local';

/** Entscheidung A (issue #722): eine Fälligkeit ohne gewählte Uhrzeit ist von
 * 09:00 nicht unterscheidbar — dieselbe Konvention wie parse-task-input.ts's
 * Default. Bewusst akzeptierter Preis, kein Fund. */
const DEFAULT_TIME = '09:00';

const WEEKDAY_HEADER = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'];
const WEEKDAY_FULL = [
  'Montag',
  'Dienstag',
  'Mittwoch',
  'Donnerstag',
  'Freitag',
  'Samstag',
  'Sonntag',
];

export interface DuePickerProps {
  /** Gleiche Wertform wie das ersetzte `datetime-local`-Feld: `JJJJ-MM-TT` +
   * `T` + `hh:mm`, oder `''` für keine Fälligkeit. */
  value: string;
  onChange: (next: string) => void;
}

function splitValue(value: string): { day: string; time: string } {
  if (!value) return { day: '', time: '' };
  const [day, time] = value.split('T');
  return { day, time: time ?? '' };
}

/** Der nächste Montag nach `dayKey` — der Montag der laufenden Woche liegt nie
 * in der Zukunft, eine Woche weiter also immer echt danach, gleich an welchem
 * Wochentag `dayKey` selbst liegt (issue #722 AK2). */
function nextMonday(dayKey: string): string {
  return addDays(weekDaysFor(dayKey)[0], 7);
}

/**
 * Schnellwahl + Monatskalender + getrennte Uhrzeit fürs Wann-Chip-Panel
 * (issue #722) — Drop-in-Ersatz für das native `datetime-local`-Feld, das es
 * ablöst: gleiche Wertform rein wie raus. Die ISO-Umrechnung bleibt an ihrer
 * einen bestehenden Stelle (`localInputToIso` in quick-add.tsx).
 */
export function DuePicker({ value, onChange }: DuePickerProps) {
  const { day, time } = splitValue(value);
  const todayKey = isoToLocalInput(new Date().toISOString()).slice(0, 10);
  const [viewedMonth, setViewedMonth] = useState(day || todayKey);
  const rootRef = useRef<HTMLDivElement>(null);

  // The panel unmounts with its chip (quick-add.tsx renders it only while
  // `openChip === 'wann'`), so this only ever runs once per open — no need to
  // re-run when the value changes underneath it.
  useEffect(() => {
    rootRef.current?.scrollIntoView({ block: 'nearest' });
  }, []);

  function setDay(nextDay: string) {
    onChange(`${nextDay}T${time || DEFAULT_TIME}`);
    setViewedMonth(nextDay);
  }

  function setTime(nextTime: string) {
    onChange(`${day || todayKey}T${nextTime || DEFAULT_TIME}`);
  }

  const days = monthDaysFor(viewedMonth);
  const viewedMonthKey = viewedMonth.slice(0, 7);

  return (
    <div className="due-picker" ref={rootRef}>
      <div className="due-picker__quick-select">
        <button type="button" className="due-picker__quick-button" onClick={() => setDay(todayKey)}>
          Heute
        </button>
        <button
          type="button"
          className="due-picker__quick-button"
          onClick={() => setDay(addDays(todayKey, 1))}
        >
          Morgen
        </button>
        <button
          type="button"
          className="due-picker__quick-button"
          onClick={() => setDay(nextMonday(todayKey))}
        >
          Nächste Woche
        </button>
      </div>
      <div className="due-picker__calendar">
        <div className="due-picker__month-row">
          <button
            type="button"
            className="due-picker__nav"
            aria-label="Voriger Monat"
            onClick={() => setViewedMonth(addMonthsClamped(viewedMonth, -1))}
          >
            <IconChevronLeft />
          </button>
          <p className="due-picker__month-title">{formatMonthTitle(viewedMonth)}</p>
          <button
            type="button"
            className="due-picker__nav"
            aria-label="Nächster Monat"
            onClick={() => setViewedMonth(addMonthsClamped(viewedMonth, 1))}
          >
            <IconChevronRight />
          </button>
        </div>
        <ul className="due-picker__weekday-header" aria-hidden="true">
          {WEEKDAY_HEADER.map((label) => (
            <li key={label}>{label}</li>
          ))}
        </ul>
        <ul className="due-picker__days">
          {days.map((dateKey, index) => {
            const isSelected = dateKey === day;
            const isOutsideMonth = dateKey.slice(0, 7) !== viewedMonthKey;
            const dayNumber = Number(dateKey.slice(-2));
            return (
              <li key={dateKey}>
                <button
                  type="button"
                  className="due-picker__day"
                  data-today={dateKey === todayKey ? '' : undefined}
                  data-outside-month={isOutsideMonth ? '' : undefined}
                  aria-pressed={isSelected}
                  aria-label={`${WEEKDAY_FULL[index % 7]}, ${dayNumber}.`}
                  onClick={() => setDay(dateKey)}
                >
                  {dayNumber}
                </button>
              </li>
            );
          })}
        </ul>
      </div>
      <div className="due-picker__time-row">
        <input
          type="time"
          className="due-picker__time"
          aria-label="Uhrzeit"
          value={time}
          onChange={(event) => setTime(event.target.value)}
        />
        <button
          type="button"
          className="due-picker__no-date"
          disabled={!value}
          onClick={() => onChange('')}
        >
          Kein Datum
        </button>
      </div>
    </div>
  );
}
