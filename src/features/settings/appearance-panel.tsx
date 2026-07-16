'use client';

import { Row } from '@/ui/row';
import { SectionCard } from '@/ui/section-card';
import { SegmentedControl, type SegmentedOption } from '@/ui/segmented-control';
import { Slider } from '@/ui/slider';
import { Toggle } from '@/ui/toggle';
import { useAppearance, type Theme, type TextScale } from './use-appearance';

const THEME_OPTIONS: SegmentedOption<Theme>[] = [
  { value: 'system', label: 'System' },
  { value: 'hell', label: 'Hell' },
  { value: 'dunkel', label: 'Dunkel' },
];

// Slider works on an even step scale; the actual factors (0.9/1/1.1/1.25) aren't
// evenly spaced, so the slider moves across this index instead.
const TEXT_SCALES: TextScale[] = [0.9, 1, 1.1, 1.25];
const TEXT_SCALE_LABELS = ['Klein', 'Standard', 'Groß', 'Sehr groß'];

/**
 * Reference implementation for the five primitives from ADR-0006. Every field here
 * is a device-local presentation pref (`use-appearance.ts`), not a synced domain value.
 */
export function AppearancePanel() {
  const { theme, reduceMotion, textScale, setTheme, setReduceMotion, setTextScale } =
    useAppearance();
  const textScaleIndex = Math.max(TEXT_SCALES.indexOf(textScale), 0);

  return (
    <SectionCard title="Darstellung">
      <Row label="Theme">
        <SegmentedControl label="Theme" options={THEME_OPTIONS} value={theme} onChange={setTheme} />
      </Row>
      <Row label="Bewegung reduzieren">
        <Toggle label="Bewegung reduzieren" checked={reduceMotion} onChange={setReduceMotion} />
      </Row>
      <Row label="Textgröße">
        <Slider
          label="Textgröße"
          min={0}
          max={TEXT_SCALES.length - 1}
          step={1}
          value={textScaleIndex}
          valueText={TEXT_SCALE_LABELS[textScaleIndex]}
          onChange={(index) => setTextScale(TEXT_SCALES[index])}
        />
      </Row>
    </SectionCard>
  );
}
