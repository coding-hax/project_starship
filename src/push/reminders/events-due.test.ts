import { describe, expect, it } from 'vitest';
import type { EventExceptionView } from '@/features/events/use-event-exceptions';
import { dueEventReminders, type EventReminderSource } from './events-due';

function event(overrides: Partial<EventReminderSource>): EventReminderSource {
  return {
    id: 'evt-1',
    title: 'Zahnarzt',
    allDay: false,
    startsAt: null,
    endsAt: null,
    startDate: null,
    endDate: null,
    category: null,
    recurrence: null,
    reminderMinutes: 15,
    deletedAt: null,
    ...overrides,
  };
}

function exception(overrides: Partial<EventExceptionView>): EventExceptionView {
  return {
    id: 'exc-1',
    eventId: 'evt-1',
    originalDate: '2026-07-27',
    cancelled: false,
    overrideStartsAt: null,
    overrideEndsAt: null,
    overrideStartDate: null,
    overrideEndDate: null,
    ...overrides,
  };
}

describe('dueEventReminders — Einzeltermin (AC1)', () => {
  // 14:00 Berlin (CEST, UTC+2) = 12:00 UTC; lead 15 min -> remindAt = 13:45 Berlin = 11:45 UTC.
  const single = event({ startsAt: '2026-07-20T12:00:00.000Z', endsAt: '2026-07-20T12:30:00.000Z' });

  it('ist fällig, sobald die Uhr den Erinnerungszeitpunkt erreicht', () => {
    const due = dueEventReminders([single], [], new Date('2026-07-20T11:45:00.000Z'));
    expect(due).toHaveLength(1);
    expect(due[0]).toMatchObject({
      lockSlot: 'evt-1',
      sendDate: '2026-07-20',
      occStart: '2026-07-20T12:00:00.000Z',
    });
    expect(due[0].payload.body).toBe('14:00 Uhr — Zahnarzt');
  });

  it('ist vor dem Erinnerungszeitpunkt noch nicht fällig (Untergrenze)', () => {
    const due = dueEventReminders([single], [], new Date('2026-07-20T11:30:00.000Z'));
    expect(due).toHaveLength(0);
  });

  it('bleibt innerhalb des Rückblick-Fensters fällig', () => {
    const due = dueEventReminders([single], [], new Date('2026-07-20T12:29:00.000Z')); // remindAt + 44min
    expect(due).toHaveLength(1);
  });

  it('ist außerhalb des Rückblick-Fensters nicht mehr fällig (Obergrenze)', () => {
    const due = dueEventReminders([single], [], new Date('2026-07-20T12:31:00.000Z')); // remindAt + 46min
    expect(due).toHaveLength(0);
  });
});

describe('dueEventReminders — Serie (AC2)', () => {
  // Weekly Monday 09:00 Berlin (CEST), anchored 2026-07-20.
  const series = event({
    startsAt: '2026-07-20T07:00:00.000Z',
    endsAt: '2026-07-20T07:30:00.000Z',
    recurrence: { freq: 'weekly', interval: 1, byWeekday: [0] },
  });

  it('erinnert an ein Serien-Vorkommen zu dessen individueller Startzeit', () => {
    // 2026-07-27 (next Monday) 08:45 Berlin = 15 min before its own 09:00.
    const due = dueEventReminders([series], [], new Date('2026-07-27T06:45:00.000Z'));
    expect(due).toHaveLength(1);
    expect(due[0]).toMatchObject({
      lockSlot: 'evt-1:2026-07-27',
      sendDate: '2026-07-27',
      occStart: '2026-07-27T07:00:00.000Z',
    });
  });

  it('erinnert nicht an einem Tag, an dem die Serie kein Vorkommen hat', () => {
    // 2026-07-21 is a Tuesday — the series only occurs on Mondays.
    const due = dueEventReminders([series], [], new Date('2026-07-21T06:45:00.000Z'));
    expect(due).toHaveLength(0);
  });

  it('erinnert ein verschobenes Vorkommen relativ zur neuen Zeit, Lock-Slot bleibt am Original-Tag', () => {
    const moved = exception({ originalDate: '2026-07-27', overrideStartsAt: '2026-07-27T13:00:00.000Z' }); // 15:00 Berlin

    // Old 09:00 raster (now unmoved reminder time) must stay silent.
    const oldRaster = dueEventReminders([series], [moved], new Date('2026-07-27T06:45:00.000Z'));
    expect(oldRaster).toHaveLength(0);

    // New 15:00 raster fires, lock slot still keyed on the original date.
    const newRaster = dueEventReminders([series], [moved], new Date('2026-07-27T12:45:00.000Z'));
    expect(newRaster).toHaveLength(1);
    expect(newRaster[0]).toMatchObject({
      lockSlot: 'evt-1:2026-07-27',
      sendDate: '2026-07-27',
      occStart: '2026-07-27T13:00:00.000Z',
    });
  });

  it('erinnert nicht an ein ausgefallenes Vorkommen', () => {
    const cancelled = exception({ originalDate: '2026-07-27', cancelled: true });
    const due = dueEventReminders([series], [cancelled], new Date('2026-07-27T06:45:00.000Z'));
    expect(due).toHaveLength(0);
  });

  it('liest 09:00 Berlin auf beiden Seiten der Frühjahrs-Umstellung (DST-Kante)', () => {
    // Anchor Monday 2026-03-23 (CET, UTC+1); 2026-03-30 is the first Monday
    // after the spring changeover (CEST, UTC+1 -> UTC+2).
    const winterAnchored = event({
      startsAt: '2026-03-23T08:00:00.000Z', // 09:00 CET
      endsAt: '2026-03-23T08:30:00.000Z',
      recurrence: { freq: 'weekly', interval: 1, byWeekday: [0] },
    });

    const due = dueEventReminders([winterAnchored], [], new Date('2026-03-30T06:45:00.000Z'));
    expect(due).toHaveLength(1);
    expect(due[0].occStart).toBe('2026-03-30T07:00:00.000Z'); // still 09:00 Berlin
  });
});

describe('dueEventReminders — Ausschlüsse', () => {
  it('ganztägige Termine lösen nie aus', () => {
    const allDay = event({ allDay: true, startDate: '2026-07-20', endDate: '2026-07-20', startsAt: null, endsAt: null });
    const due = dueEventReminders([allDay], [], new Date('2026-07-20T12:00:00.000Z'));
    expect(due).toHaveLength(0);
  });

  it('Termine ohne reminderMinutes lösen nie aus', () => {
    const noReminder = event({
      reminderMinutes: null,
      startsAt: '2026-07-20T12:00:00.000Z',
      endsAt: '2026-07-20T12:30:00.000Z',
    });
    const due = dueEventReminders([noReminder], [], new Date('2026-07-20T11:45:00.000Z'));
    expect(due).toHaveLength(0);
  });

  it('gelöschte Termine lösen nie aus', () => {
    const deleted = event({
      deletedAt: '2026-07-19T00:00:00.000Z',
      startsAt: '2026-07-20T12:00:00.000Z',
      endsAt: '2026-07-20T12:30:00.000Z',
    });
    const due = dueEventReminders([deleted], [], new Date('2026-07-20T11:45:00.000Z'));
    expect(due).toHaveLength(0);
  });
});
