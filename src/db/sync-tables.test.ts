import { getTableColumns } from 'drizzle-orm';
import type { PgTable } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import { missingRequired, SYNC_REGISTRY, writableFields } from './sync-tables';

describe('writableFields', () => {
  it('keeps the whitelisted fields', () => {
    expect(writableFields('sync_state', { key: 'a', value: { n: 1 } })).toEqual({
      key: 'a',
      value: { n: 1 },
    });
  });

  it('drops fields a client must never set', () => {
    // The whole point of the whitelist: without it a mutation could backdate
    // updated_at and walk straight through last-write-wins.
    const fields = writableFields('sync_state', {
      key: 'a',
      value: 1,
      id: 'attacker-chosen',
      updatedAt: '1970-01-01T00:00:00.000Z',
      deletedAt: null,
    });

    expect(fields).toEqual({ key: 'a', value: 1 });
    expect(fields).not.toHaveProperty('id');
    expect(fields).not.toHaveProperty('updatedAt');
  });

  it('omits absent fields rather than nulling them — payloads are partial', () => {
    // A mutation that only touches `value` must not wipe `key`.
    expect(writableFields('sync_state', { value: 2 })).toEqual({ value: 2 });
  });
});

describe('missingRequired', () => {
  it('passes when every NOT NULL column is present', () => {
    expect(missingRequired('sync_state', { key: 'a', value: 1 })).toEqual([]);
  });

  it('names what a create is missing, so the push can 400 instead of 500', () => {
    expect(missingRequired('sync_state', { value: 1 })).toEqual(['key']);
    expect(missingRequired('sync_state', {})).toEqual(['key', 'value']);
  });
});

describe('writableFields for tasks', () => {
  it('keeps the whitelisted fields', () => {
    expect(
      writableFields('tasks', {
        title: 'Milch kaufen',
        notes: 'fettarm',
        dueAt: '2026-07-15T00:00:00.000Z',
        priority: 1,
        completedAt: null,
        recurrenceRule: null,
      }),
    ).toEqual({
      title: 'Milch kaufen',
      notes: 'fettarm',
      // A timestamp column needs a Date to insert/update — the wire format only has
      // the ISO string.
      dueAt: new Date('2026-07-15T00:00:00.000Z'),
      priority: 1,
      completedAt: null,
      recurrenceRule: null,
    });
  });

  it('converts a timestamp field to a Date, leaving null as-is', () => {
    const fields = writableFields('tasks', {
      title: 'Wäsche',
      completedAt: '2026-07-15T09:00:00.000Z',
    });

    expect(fields.completedAt).toBeInstanceOf(Date);
    expect((fields.completedAt as Date).toISOString()).toBe('2026-07-15T09:00:00.000Z');

    expect(writableFields('tasks', { title: 'Wäsche', completedAt: null }).completedAt).toBeNull();
  });

  it('drops fields a client must never set', () => {
    const fields = writableFields('tasks', {
      title: 'Milch kaufen',
      id: 'attacker-chosen',
      updatedAt: '1970-01-01T00:00:00.000Z',
      deletedAt: null,
    });

    expect(fields).toEqual({ title: 'Milch kaufen' });
    expect(fields).not.toHaveProperty('id');
    expect(fields).not.toHaveProperty('updatedAt');
  });
});

describe('writableFields for tasks.parentId (issue #89)', () => {
  it('passes a uuid through unchanged — parentId is not a timestamp column', () => {
    expect(
      writableFields('tasks', { title: 'Wäsche', parentId: 'parent-uuid' }).parentId,
    ).toBe('parent-uuid');
  });

  it('allows null — un-nesting back to top-level', () => {
    expect(writableFields('tasks', { title: 'Wäsche', parentId: null }).parentId).toBeNull();
  });

  it('is not required — a create without parentId is still valid', () => {
    expect(missingRequired('tasks', { title: 'Wäsche' })).toEqual([]);
  });
});

describe('missingRequired for tasks', () => {
  it('passes when title is present', () => {
    expect(missingRequired('tasks', { title: 'Milch kaufen' })).toEqual([]);
  });

  it('names the missing title, so the push can 400 instead of 500', () => {
    expect(missingRequired('tasks', {})).toEqual(['title']);
  });
});

describe('writableFields for habits', () => {
  it('keeps the whitelisted fields, coercing timestamp columns to Date', () => {
    const fields = writableFields('habits', {
      name: 'Meditieren',
      schedule: 'daily',
      color: '#7c9885',
      archivedAt: null,
      createdAt: '2026-07-15T09:00:00.000Z',
    });

    expect(fields.name).toBe('Meditieren');
    expect(fields.schedule).toBe('daily');
    expect(fields.color).toBe('#7c9885');
    expect(fields.archivedAt).toBeNull();
    expect(fields.createdAt).toBeInstanceOf(Date);
    expect((fields.createdAt as Date).toISOString()).toBe('2026-07-15T09:00:00.000Z');
  });

  it('drops fields a client must never set', () => {
    const fields = writableFields('habits', {
      name: 'Meditieren',
      schedule: 'daily',
      id: 'attacker-chosen',
      updatedAt: '1970-01-01T00:00:00.000Z',
    });

    expect(fields).toEqual({ name: 'Meditieren', schedule: 'daily' });
    expect(fields).not.toHaveProperty('id');
    expect(fields).not.toHaveProperty('updatedAt');
  });

  it('keeps target (issue #509), the DB default fills it in when a client omits it', () => {
    const fields = writableFields('habits', {
      name: 'Laufen',
      schedule: 'weekly',
      target: 3,
    });

    expect(fields.target).toBe(3);
  });
});

describe('missingRequired for habits', () => {
  it('passes when name and schedule are present', () => {
    expect(missingRequired('habits', { name: 'Meditieren', schedule: 'daily' })).toEqual([]);
  });

  it('names what a create is missing', () => {
    expect(missingRequired('habits', { name: 'Meditieren' })).toEqual(['schedule']);
    expect(missingRequired('habits', {})).toEqual(['name', 'schedule']);
  });

  it('does not require target — a pre-#509 client can still push (target defaults in the DB)', () => {
    expect(missingRequired('habits', { name: 'Meditieren', schedule: 'daily' })).toEqual([]);
  });
});

describe('writableFields for habit_logs (issue #101)', () => {
  it('keeps the whitelisted fields', () => {
    expect(
      writableFields('habit_logs', {
        habitId: 'habit-uuid',
        logDate: '2026-07-15',
        done: true,
      }),
    ).toEqual({ habitId: 'habit-uuid', logDate: '2026-07-15', done: true });
  });

  it('leaves logDate as a plain YYYY-MM-DD string — it is a calendar day, not a timestamp', () => {
    // The wire format for a `date` column is already `dataType: 'string'` in
    // Drizzle (unlike `timestamp`, which is `'date'`), so writableFields must NOT
    // run it through `new Date(...)` — that would risk a timezone-shifted day.
    const fields = writableFields('habit_logs', {
      habitId: 'habit-uuid',
      logDate: '2026-07-15',
    });

    expect(fields.logDate).toBe('2026-07-15');
    expect(fields.logDate).not.toBeInstanceOf(Date);
  });

  it('drops fields a client must never set', () => {
    const fields = writableFields('habit_logs', {
      habitId: 'habit-uuid',
      logDate: '2026-07-15',
      id: 'attacker-chosen',
      syncSeq: 999,
    });

    expect(fields).toEqual({ habitId: 'habit-uuid', logDate: '2026-07-15' });
    expect(fields).not.toHaveProperty('id');
    expect(fields).not.toHaveProperty('syncSeq');
  });
});

describe('missingRequired for habit_logs', () => {
  it('passes when habitId and logDate are present', () => {
    expect(missingRequired('habit_logs', { habitId: 'habit-uuid', logDate: '2026-07-15' })).toEqual(
      [],
    );
  });

  it('names what a create is missing', () => {
    expect(missingRequired('habit_logs', { habitId: 'habit-uuid' })).toEqual(['logDate']);
    expect(missingRequired('habit_logs', {})).toEqual(['habitId', 'logDate']);
  });
});

describe('garmin_activities is read-only', () => {
  it('has no writable or required fields — a mutation can never create/update it', () => {
    expect(SYNC_REGISTRY.garmin_activities.writable).toEqual([]);
    expect(SYNC_REGISTRY.garmin_activities.required).toEqual([]);
  });

  it('writableFields strips every field, even ones a client might send', () => {
    expect(
      writableFields('garmin_activities', { name: 'Lauf', distanceMeters: 5000 }),
    ).toEqual({});
  });

  it('is flagged readOnly with a non-empty readable projection for pull', () => {
    expect(SYNC_REGISTRY.garmin_activities.readOnly).toBe(true);
    expect(SYNC_REGISTRY.garmin_activities.readable.length).toBeGreaterThan(0);
  });
});

describe('writableFields for events (issue #552)', () => {
  it('coerces starts_at/ends_at to Date across the autumn DST fold (AC5)', () => {
    // 2026-10-25 is the DST fold in Europe/Berlin — a naive local datetime is
    // ambiguous there, a UTC instant is not. The round trip must be exact.
    const fields = writableFields('events', {
      title: 'Arzttermin',
      allDay: false,
      startsAt: '2026-10-25T00:30:00.000Z',
      endsAt: '2026-10-25T01:30:00.000Z',
    });

    expect(fields.startsAt).toBeInstanceOf(Date);
    expect((fields.startsAt as Date).toISOString()).toBe('2026-10-25T00:30:00.000Z');
    expect(fields.endsAt).toBeInstanceOf(Date);
    expect((fields.endsAt as Date).toISOString()).toBe('2026-10-25T01:30:00.000Z');
  });

  it('leaves start_date/end_date as a plain YYYY-MM-DD string, never a Date (AC5)', () => {
    // Same DST-fold day, but as an all-day event — must not be run through
    // `new Date(...)`, which would risk a timezone-shifted calendar day.
    const fields = writableFields('events', {
      title: 'Urlaub',
      allDay: true,
      startDate: '2026-10-25',
      endDate: '2026-10-27',
    });

    expect(fields.startDate).toBe('2026-10-25');
    expect(fields.startDate).not.toBeInstanceOf(Date);
    expect(fields.endDate).toBe('2026-10-27');
    expect(fields.endDate).not.toBeInstanceOf(Date);
  });

  it('keeps category/recurrence/reminderMinutes unchanged — not timestamp columns', () => {
    const fields = writableFields('events', {
      title: 'Wöchentliches Meeting',
      category: 'arbeit',
      recurrence: { freq: 'weekly', interval: 1 },
      reminderMinutes: 15,
    });

    expect(fields.category).toBe('arbeit');
    expect(fields.recurrence).toEqual({ freq: 'weekly', interval: 1 });
    expect(fields.reminderMinutes).toBe(15);
  });

  it('drops fields a client must never set', () => {
    const fields = writableFields('events', {
      title: 'Arzttermin',
      id: 'attacker-chosen',
      updatedAt: '1970-01-01T00:00:00.000Z',
    });

    expect(fields).toEqual({ title: 'Arzttermin' });
    expect(fields).not.toHaveProperty('id');
    expect(fields).not.toHaveProperty('updatedAt');
  });
});

describe('missingRequired for events', () => {
  it('passes when title is present', () => {
    expect(missingRequired('events', { title: 'Arzttermin' })).toEqual([]);
  });

  it('names the missing title, so the push can 400 instead of 500', () => {
    expect(missingRequired('events', {})).toEqual(['title']);
  });
});

describe('writableFields for event_exceptions (issue #552)', () => {
  it('keeps the whitelisted fields, leaving originalDate a string and coercing overrides to Date', () => {
    const fields = writableFields('event_exceptions', {
      eventId: 'event-uuid',
      originalDate: '2026-10-25',
      cancelled: false,
      overrideStartsAt: '2026-10-26T09:00:00.000Z',
      overrideStartDate: null,
    });

    expect(fields.eventId).toBe('event-uuid');
    expect(fields.originalDate).toBe('2026-10-25');
    expect(fields.originalDate).not.toBeInstanceOf(Date);
    expect(fields.cancelled).toBe(false);
    expect(fields.overrideStartsAt).toBeInstanceOf(Date);
    expect(fields.overrideStartDate).toBeNull();
  });

  it('drops fields a client must never set', () => {
    const fields = writableFields('event_exceptions', {
      eventId: 'event-uuid',
      originalDate: '2026-10-25',
      id: 'attacker-chosen',
      syncSeq: 999,
    });

    expect(fields).toEqual({ eventId: 'event-uuid', originalDate: '2026-10-25' });
    expect(fields).not.toHaveProperty('id');
    expect(fields).not.toHaveProperty('syncSeq');
  });
});

describe('missingRequired for event_exceptions', () => {
  it('passes when eventId and originalDate are present', () => {
    expect(
      missingRequired('event_exceptions', { eventId: 'event-uuid', originalDate: '2026-10-25' }),
    ).toEqual([]);
  });

  it('names what a create is missing', () => {
    expect(missingRequired('event_exceptions', { eventId: 'event-uuid' })).toEqual(['originalDate']);
    expect(missingRequired('event_exceptions', {})).toEqual(['eventId', 'originalDate']);
  });
});

describe('events/event_exceptions time-model columns (issue #552 AC5/AC6)', () => {
  it('starts_at/ends_at are timestamptz, start_date/end_date are a bare date — never the same column type', () => {
    const columns = getTableColumns(SYNC_REGISTRY.events.table as PgTable);

    expect(columns.startsAt.columnType).toBe('PgTimestamp');
    expect((columns.startsAt as unknown as { withTimezone: boolean }).withTimezone).toBe(true);
    expect(columns.endsAt.columnType).toBe('PgTimestamp');
    expect(columns.startDate.columnType).not.toBe('PgTimestamp');
    expect(columns.endDate.columnType).not.toBe('PgTimestamp');
  });

  it('events carries no exceptions list column — event_exceptions is the only home for them (AC6)', () => {
    const columns = getTableColumns(SYNC_REGISTRY.events.table as PgTable);
    expect(columns).not.toHaveProperty('exceptions');
  });

  it('event_exceptions references the series by event_id, not the other way round (AC6)', () => {
    const columns = getTableColumns(SYNC_REGISTRY.event_exceptions.table as PgTable);
    expect(columns).toHaveProperty('eventId');
  });
});

describe('sync columns present', () => {
  // A synchronised table without these carries no way to soft-delete or resolve
  // conflicts — typecheck alone would not catch a table that forgets to spread
  // `syncColumns` (SYNC_REGISTRY types `table` as `unknown`).
  const requiredColumns = ['id', 'updated_at', 'deleted_at', 'synced_at'];

  it.each(Object.keys(SYNC_REGISTRY))('%s carries every sync column', (name) => {
    const entry = SYNC_REGISTRY[name as keyof typeof SYNC_REGISTRY];
    const columns = getTableColumns(entry.table as PgTable);
    const columnNames = Object.values(columns).map((column) => column.name);

    for (const required of requiredColumns) {
      expect(columnNames).toContain(required);
    }
  });
});
