import { MODULES, type NavItem } from '@/modules/registry';

export type { NavItem };

/**
 * One source for every nav entry — derived from the module registry (ADR-0012,
 * issue #307), which owns the actual `NavItem` objects. `nav.tsx` and the settings
 * order panel both read from here (issue #205); name and shape are unchanged from
 * before #307 so neither import needed to move.
 */
export const NAV_ITEMS: readonly NavItem[] = MODULES.flatMap((module) => (module.navItem ? [module.navItem] : []));
