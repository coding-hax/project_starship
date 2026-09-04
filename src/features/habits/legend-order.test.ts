import { describe, expect, it } from 'vitest';

import { legendOrder } from './legend-order';
import type { HabitView } from './use-habits';

function habit(overrides: Partial<HabitView> & Pick<HabitView, 'id' | 'name' | 'createdAt'>): HabitView {
  return {
    schedule: 'daily',
    target: 1,
    color: null,
    archivedAt: null,
    ...overrides,
  };
}

describe('legendOrder', () => {
  it('sorts by descending name length', () => {
    const short = habit({ id: 'a', name: 'Kurz', createdAt: '2024-01-01T00:00:00.000Z' });
    const long = habit({ id: 'b', name: 'Ein sehr langer Name', createdAt: '2024-01-02T00:00:00.000Z' });
    const medium = habit({ id: 'c', name: 'Mittel', createdAt: '2024-01-03T00:00:00.000Z' });

    expect(legendOrder([short, long, medium])).toEqual([long, medium, short]);
  });

  it('breaks ties by createdAt (compareHabits order)', () => {
    const first = habit({ id: 'a', name: 'Gleich', createdAt: '2024-01-01T00:00:00.000Z' });
    const second = habit({ id: 'b', name: 'Gleich', createdAt: '2024-01-02T00:00:00.000Z' });

    expect(legendOrder([second, first])).toEqual([first, second]);
  });

  it('returns an empty array for an empty list', () => {
    expect(legendOrder([])).toEqual([]);
  });

  it('returns a single-element list unchanged', () => {
    const only = habit({ id: 'a', name: 'Solo', createdAt: '2024-01-01T00:00:00.000Z' });

    expect(legendOrder([only])).toEqual([only]);
  });

  it('does not mutate the input array', () => {
    const short = habit({ id: 'a', name: 'Kurz', createdAt: '2024-01-01T00:00:00.000Z' });
    const long = habit({ id: 'b', name: 'Ein sehr langer Name', createdAt: '2024-01-02T00:00:00.000Z' });
    const input = [short, long];

    legendOrder(input);

    expect(input).toEqual([short, long]);
  });
});
