'use client';

import type { ComponentType } from 'react';
import { useModules } from '@/features/settings/use-modules';
import { MODULES, type ModuleDefinition } from './registry';

/**
 * Resolves an explicit, page-owned `order` of module ids to the active ones'
 * component for the given slot (`OverviewSection`/`SettingsPanel`, issue #308).
 * `order` is explicit rather than `MODULES` order itself, because the two
 * pages disagree on it (the overview puts Wetter before Aufgaben, the
 * registry doesn't) — filtering beim Rendern (ADR-0012 K3) still applies:
 * position comes from `order`, only visibility from `isActive`.
 */
export function useActiveSections(
  order: readonly string[],
  pick: (module: ModuleDefinition) => ComponentType | undefined,
): Array<{ id: string; Component: ComponentType }> {
  const { isActive } = useModules();

  return order.flatMap((id) => {
    const mod = MODULES.find((m) => m.id === id);
    if (!mod || !isActive(id)) return [];
    const Component = pick(mod);
    return Component ? [{ id, Component }] : [];
  });
}
