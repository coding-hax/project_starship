import { compareHabits } from './use-habits';
import type { HabitView } from './use-habits';

/**
 * Legend order for habit-history-card.tsx (issue #1078): descending name
 * length so `flex-wrap` (next-fit) packs rows tighter than the plain
 * `compareHabits` order, which lets a short first entry strand later, shorter
 * entries onto their own line behind a long one. Ties fall back to
 * `compareHabits` for determinism.
 */
export function legendOrder<T extends HabitView>(habits: T[]): T[] {
  return [...habits].sort((a, b) => b.name.length - a.name.length || compareHabits(a, b));
}
