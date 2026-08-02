import { describe, expect, it } from 'vitest';
import { nextPresenceEntries, settlePresenceEntry, type ListPresenceEntry } from './use-list-presence';

interface Row {
  id: string;
  label: string;
}

const getKey = (row: Row) => row.id;

describe('nextPresenceEntries', () => {
  it('stays unestablished and unchanged while items is still empty (loading)', () => {
    const step = nextPresenceEntries([], false, [], getKey);
    expect(step.established).toBe(false);
    expect(step.entries).toEqual([]);
  });

  it('seeds the first non-empty snapshot as present, never entering', () => {
    const items = [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }];
    const step = nextPresenceEntries([], false, items, getKey);
    expect(step.established).toBe(true);
    expect(step.entries).toEqual([
      { key: 'a', item: items[0], status: 'present' },
      { key: 'b', item: items[1], status: 'present' },
    ]);
  });

  it('marks a newly added key as entering once established', () => {
    const prev: ListPresenceEntry<Row>[] = [{ key: 'a', item: { id: 'a', label: 'A' }, status: 'present' }];
    const items = [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }];
    const step = nextPresenceEntries(prev, true, items, getKey);
    expect(step.entries).toEqual([
      { key: 'a', item: items[0], status: 'present' },
      { key: 'b', item: items[1], status: 'entering' },
    ]);
  });

  it('inserts a new key at its position from items, not always at the end', () => {
    const prev: ListPresenceEntry<Row>[] = [
      { key: 'a', item: { id: 'a', label: 'A' }, status: 'present' },
      { key: 'c', item: { id: 'c', label: 'C' }, status: 'present' },
    ];
    const items = [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }, { id: 'c', label: 'C' }];
    const step = nextPresenceEntries(prev, true, items, getKey);
    expect(step.entries.map((entry) => entry.key)).toEqual(['a', 'b', 'c']);
    expect(step.entries.find((entry) => entry.key === 'b')?.status).toBe('entering');
  });

  it('marks a removed key as leaving and keeps it at its previous position', () => {
    const prev: ListPresenceEntry<Row>[] = [
      { key: 'a', item: { id: 'a', label: 'A' }, status: 'present' },
      { key: 'b', item: { id: 'b', label: 'B' }, status: 'present' },
      { key: 'c', item: { id: 'c', label: 'C' }, status: 'present' },
    ];
    const items = [{ id: 'a', label: 'A' }, { id: 'c', label: 'C' }];
    const step = nextPresenceEntries(prev, true, items, getKey);
    expect(step.entries.map((entry) => [entry.key, entry.status])).toEqual([
      ['a', 'present'],
      ['b', 'leaving'],
      ['c', 'present'],
    ]);
  });

  it('refreshes the item on an unchanged key without touching its status', () => {
    const prev: ListPresenceEntry<Row>[] = [{ key: 'a', item: { id: 'a', label: 'A' }, status: 'entering' }];
    const items = [{ id: 'a', label: 'A (edited)' }];
    const step = nextPresenceEntries(prev, true, items, getKey);
    expect(step.entries).toEqual([{ key: 'a', item: items[0], status: 'entering' }]);
  });
});

describe('settlePresenceEntry', () => {
  it('settles an entering row to present', () => {
    const entries: ListPresenceEntry<Row>[] = [{ key: 'a', item: { id: 'a', label: 'A' }, status: 'entering' }];
    expect(settlePresenceEntry(entries, 'a')).toEqual([{ key: 'a', item: { id: 'a', label: 'A' }, status: 'present' }]);
  });

  it('drops a leaving row once its exit animation ends', () => {
    const entries: ListPresenceEntry<Row>[] = [
      { key: 'a', item: { id: 'a', label: 'A' }, status: 'present' },
      { key: 'b', item: { id: 'b', label: 'B' }, status: 'leaving' },
    ];
    expect(settlePresenceEntry(entries, 'b')).toEqual([
      { key: 'a', item: { id: 'a', label: 'A' }, status: 'present' },
    ]);
  });

  it('ignores a stray animationend for an unrelated or already-settled key', () => {
    const entries: ListPresenceEntry<Row>[] = [{ key: 'a', item: { id: 'a', label: 'A' }, status: 'present' }];
    expect(settlePresenceEntry(entries, 'ghost')).toEqual(entries);
  });
});
