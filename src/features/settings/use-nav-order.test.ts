import { describe, expect, it } from 'vitest';
import { resolveOrder } from './use-nav-order';

const items = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];

describe('resolveOrder', () => {
  it('returns items in the stored order', () => {
    expect(resolveOrder(['c', 'a', 'b'], items)).toEqual([{ id: 'c' }, { id: 'a' }, { id: 'b' }]);
  });

  it('drops ids no longer present among items', () => {
    expect(resolveOrder(['c', 'ghost', 'a', 'b'], items)).toEqual([
      { id: 'c' },
      { id: 'a' },
      { id: 'b' },
    ]);
  });

  it('appends ids missing from the stored order at the end, in item order', () => {
    expect(resolveOrder(['b'], items)).toEqual([{ id: 'b' }, { id: 'a' }, { id: 'c' }]);
  });

  it('falls back to item order when nothing is stored yet', () => {
    expect(resolveOrder([], items)).toEqual(items);
  });
});
