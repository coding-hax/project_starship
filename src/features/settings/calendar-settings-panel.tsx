import { CategoryColorsPanel } from './category-colors-panel';
import { IcsSubscriptionsPanel } from './ics-subscriptions-panel';

/**
 * A `ModuleDefinition` has exactly one `SettingsPanel` slot (registry.ts) —
 * kalender's was `IcsSubscriptionsPanel` alone before issue #660 added a second
 * panel. This wrapper renders both, kept in one file rather than growing
 * `ModuleDefinition.SettingsPanel` into a list, which would touch every other
 * module's registry entry for a need only this module has so far.
 */
export function CalendarSettingsPanel() {
  return (
    <>
      <CategoryColorsPanel />
      <IcsSubscriptionsPanel />
    </>
  );
}
