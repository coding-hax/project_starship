'use client';

import { historyRangeLabel } from '@/features/habits/history-grid';
import { Row } from '@/ui/row';
import { SectionCard } from '@/ui/section-card';
import { Slider } from '@/ui/slider';
import { useHabitHistoryRange, type HabitHistoryRangeDays } from './use-habit-history-range';

/** Slider index → window size, in the fixed order AK9 asks for. */
const RANGE_DAYS: HabitHistoryRangeDays[] = [30, 28, 21, 14, 7];

/** Spoken/accessible names (AK9: "die zugänglichen Namen sind die ausgeschriebenen Werte") —
 *  the same wording `habit-history-card.tsx`'s own head label uses. */
const RANGE_LABELS = RANGE_DAYS.map(historyRangeLabel);

/** Visible row text — abbreviated so five options plus a slider still fit a 375px row (AK9). */
const RANGE_SHORT_LABELS = ['30 Tage', '4 Wo.', '3 Wo.', '2 Wo.', '1 Wo.'];

/**
 * "Verlauf" — the habit history card's window size (issue #1184 AK9), the
 * `routinen` module's `SettingsPanel` (registry.ts). Gated on the module
 * being active for free: `EinstellungenSections` only renders a
 * `SettingsPanel` for a module `useActiveSections` reports as on.
 */
export function RoutinesSettingsPanel() {
  const { windowDays, setWindowDays } = useHabitHistoryRange();
  const index = Math.max(RANGE_DAYS.indexOf(windowDays), 0);

  return (
    <SectionCard title="Routinen" className="routines-settings-panel">
      <Row label="Verlauf">
        <span className="routines-settings-panel__value">{RANGE_SHORT_LABELS[index]}</span>
        <Slider
          label="Verlauf"
          min={0}
          max={RANGE_DAYS.length - 1}
          step={1}
          value={index}
          valueText={RANGE_LABELS[index]}
          onChange={(next) => setWindowDays(RANGE_DAYS[next])}
        />
      </Row>
    </SectionCard>
  );
}
