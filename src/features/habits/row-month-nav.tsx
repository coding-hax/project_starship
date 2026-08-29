'use client';

import { IconChevronLeft, IconChevronRight } from '@/ui/icons';
import { addMonths, monthLabel } from './due-today';

export interface RowMonthNavProps {
  viewedMonth: Date;
  onChange: (month: Date) => void;
}

/**
 * Per-row month bar inside an expanded habit-table row (issue #905) — each row
 * blättert für sich, anders als der einzelne geteilte `MonthNav` aus
 * `habit-list.tsx`, der bisher alle Raster gleichzeitig steuerte.
 */
export function RowMonthNav({ viewedMonth, onChange }: RowMonthNavProps) {
  return (
    <div className="habit-table__month-nav">
      <button
        type="button"
        className="habit-table__month-nav-button"
        aria-label="Vorheriger Monat"
        onClick={() => onChange(addMonths(viewedMonth, -1))}
      >
        <IconChevronLeft />
      </button>
      <span className="habit-table__month-nav-label">{monthLabel(viewedMonth)}</span>
      <button
        type="button"
        className="habit-table__month-nav-button"
        aria-label="Nächster Monat"
        onClick={() => onChange(addMonths(viewedMonth, 1))}
      >
        <IconChevronRight />
      </button>
    </div>
  );
}
