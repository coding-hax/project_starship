import { describe, expect, it } from 'vitest';
import { LEGACY_MODULE_IDS, migrateModuleIds } from './module-ids';

describe('migrateModuleIds', () => {
  it('maps a renamed id to its current one', () => {
    expect(migrateModuleIds(['gewohnheiten'])).toEqual(['routinen']);
  });

  it('keeps the position of a renamed id — this is what saves the stored nav order', () => {
    expect(migrateModuleIds(['uebersicht', 'gewohnheiten', 'aufgaben'])).toEqual([
      'uebersicht',
      'routinen',
      'aufgaben',
    ]);
  });

  it('leaves ids it does not know untouched', () => {
    expect(migrateModuleIds(['aufgaben', 'kalender'])).toEqual(['aufgaben', 'kalender']);
  });

  it('passes through an unknown id rather than dropping it', () => {
    // A module simply not registered in this build must survive a round trip — the
    // callers already tolerate unknown ids, and dropping here would lose the entry.
    expect(migrateModuleIds(['ghost'])).toEqual(['ghost']);
  });

  it('collapses old and new id to one entry, keeping the earlier position', () => {
    // An interrupted migration or a hand-edited value can hold both. Without the
    // dedupe, resolveOrder() would render the same nav entry twice.
    expect(migrateModuleIds(['gewohnheiten', 'aufgaben', 'routinen'])).toEqual([
      'routinen',
      'aufgaben',
    ]);
  });

  it('is idempotent — mapping an already-migrated list changes nothing', () => {
    const once = migrateModuleIds(['uebersicht', 'gewohnheiten']);
    expect(migrateModuleIds(once)).toEqual(once);
  });

  it('does not treat inherited Object properties as a rename', () => {
    // localStorage holds whatever the user's device put there. A plain-object lookup
    // would resolve 'constructor' to Function and hand a non-string id to the callers.
    expect(migrateModuleIds(['constructor', '__proto__', 'toString'])).toEqual([
      'constructor',
      '__proto__',
      'toString',
    ]);
  });

  it('returns an empty list unchanged', () => {
    expect(migrateModuleIds([])).toEqual([]);
  });

  it('never maps an id onto one that is still in use as a source', () => {
    // A chain (a -> b, b -> c) would resolve differently depending on iteration order.
    // Keeping the map flat is what makes a single pass correct.
    for (const target of LEGACY_MODULE_IDS.values()) {
      expect(LEGACY_MODULE_IDS.has(target)).toBe(false);
    }
  });
});
