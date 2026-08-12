/**
 * Module ids renamed after shipping, stored id → current id.
 *
 * Both device-local stores key on the module id — `starship:nav-order`
 * (`use-nav-order.ts`) and `starship:modules-off` (`use-modules.ts`) — and both
 * readers ignore ids they do not recognise. Without a mapping on read, a rename is
 * silently destructive in two different ways: `resolveOrder()` drops the unknown id
 * and re-appends the module at the *end* of the nav carousel, and the off-list stops
 * matching, so a module the user had switched off comes back **on**.
 *
 * Entries are keyed by what may still sit in some device's localStorage, so they stay
 * forever — there is no way to observe that every device has been through the mapping.
 */
export const LEGACY_MODULE_IDS: ReadonlyMap<string, string> = new Map([
  ['gewohnheiten', 'routinen'], // issue #655
]);

/**
 * Maps stored ids to current ones, dropping duplicates. Unknown ids pass through
 * untouched — the callers already tolerate them, and dropping here would throw away
 * an id belonging to a module that simply is not registered in this build.
 *
 * Deduplication is not cosmetic: a device that stored both the old and the new id
 * (an interrupted migration, a hand-edited value) would otherwise yield the same
 * module twice, and `resolveOrder()` renders one nav entry per stored id.
 */
export function migrateModuleIds(ids: readonly string[]): string[] {
  const seen = new Set<string>();
  const migrated: string[] = [];
  for (const id of ids) {
    const current = LEGACY_MODULE_IDS.get(id) ?? id;
    if (seen.has(current)) continue;
    seen.add(current);
    migrated.push(current);
  }
  return migrated;
}
