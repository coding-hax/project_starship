import { eq, inArray, sql } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import { db } from '@/db';
import { garminActivities } from '@/db/schema';
import { acquireSyncWriteLock } from '@/db/sync-lock';
import { activityChanged, type ActivitySnapshot } from './activity-diff';
import { buildTrack, mapActivityListEntry, type Track } from './activity-mapper';
import { fetchActivityDetails, fetchActivityList } from './connect-api';
import { fetchStaticMap, type TrackPoint } from './static-map';
import { ensureAccessToken } from './tokens';

/** Default cron window — a week is enough to catch anything a previous run missed. */
const DEFAULT_WINDOW_DAYS = 7;

/** A single page comfortably covers a personal account's activity count in any realistic window. */
const LIST_PAGE_LIMIT = 200;

export interface SyncActivitiesResult {
  scanned: number;
  created: number;
  updated: number;
  detailsFilled: number;
  mapsFilled: number;
}

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * `days` explicit (query param) wins. Otherwise: an empty table means this is the
 * very first run, so the wider `GARMIN_BACKFILL_DAYS` window applies instead of
 * the day-to-day default — the first pull would otherwise silently miss
 * everything older than a week (ADR-0011).
 */
async function resolveWindowDays(explicit: number | undefined): Promise<number> {
  if (explicit !== undefined) return explicit;

  const [anyRow] = await db.select({ id: garminActivities.id }).from(garminActivities).limit(1);
  if (anyRow) return DEFAULT_WINDOW_DAYS;

  const backfill = Number.parseInt(process.env.GARMIN_BACKFILL_DAYS ?? '', 10);
  return Number.isFinite(backfill) && backfill > 0 ? backfill : 45;
}

function trackPoints(track: ReturnType<typeof buildTrack>): TrackPoint[] {
  if (!track?.lat || !track.lon) return [];
  const points: TrackPoint[] = [];
  for (let i = 0; i < track.n; i++) {
    const lat = track.lat[i];
    const lon = track.lon[i];
    if (lat != null && lon != null) points.push({ lat, lon });
  }
  return points;
}

/**
 * The full flow behind `POST /api/garmin-sync`, without any HTTP-handler concern,
 * so it is testable without a request (CODEMAP).
 *
 * Network work happens entirely before the write transaction — holding
 * `pg_advisory_xact_lock` across the Garmin HTTP calls would block every client
 * push for as long as they take. The transaction only ever does the writes, and
 * takes the same lock `push` does (`src/db/sync-lock.ts`) so the two can never
 * hand out `sync_seq` out of commit order (ADR-0008).
 *
 * A row is only ever written when `activityChanged` says something really
 * changed — otherwise every cron run would bump every activity's `sync_seq` and
 * every device would re-pull an identical row, map image included.
 */
export async function syncActivities(options: { days?: number } = {}): Promise<SyncActivitiesResult> {
  const accessToken = await ensureAccessToken();

  const days = await resolveWindowDays(options.days);
  const endDate = new Date();
  const startDate = new Date(endDate.getTime() - days * 24 * 60 * 60 * 1000);

  const list = await fetchActivityList(accessToken, {
    start: 0,
    limit: LIST_PAGE_LIMIT,
    startDate: isoDate(startDate),
    endDate: isoDate(endDate),
  });

  const ids = list.map((entry) => entry.activityId);
  const existingRows = ids.length
    ? await db.select().from(garminActivities).where(inArray(garminActivities.garminActivityId, ids))
    : [];
  const existingById = new Map(existingRows.map((row) => [row.garminActivityId, row]));

  let created = 0;
  let updated = 0;
  let detailsFilled = 0;
  let mapsFilled = 0;
  const now = new Date();

  interface PendingWrite {
    isNew: boolean;
    id: string;
    fields: ActivitySnapshot;
    fetchedAt: Date;
  }
  const pending: PendingWrite[] = [];

  for (const entry of list) {
    const header = mapActivityListEntry(entry);
    const existing = existingById.get(entry.activityId);

    let track = (existing?.track as Track | null | undefined) ?? null;
    let mapImage = existing?.mapImage ?? null;
    let fetchedAt = existing?.fetchedAt ?? now;

    // A completed activity's track never changes — fetch it exactly once, either
    // on first sight or (issue #186 AC5, "Teilerfolg ist Erfolg") on a later run
    // that retries a previously failed detail fetch.
    if (track === null) {
      try {
        const details = await fetchActivityDetails(accessToken, entry.activityId);
        const builtTrack = buildTrack(details);
        if (builtTrack) {
          track = builtTrack;
          detailsFilled += 1;
          const map = await fetchStaticMap(trackPoints(builtTrack));
          if (map) {
            mapImage = map;
            mapsFilled += 1;
          }
        }
        fetchedAt = now;
      } catch {
        // Kept null. The header still gets written below — a failed detail/map
        // fetch never blocks the rest of the sync, and the next run retries it.
      }
    }

    const candidate: ActivitySnapshot = { ...header, track, mapImage };

    if (!existing) {
      pending.push({ isNew: true, id: uuidv7(), fields: candidate, fetchedAt });
    } else if (activityChanged(existing as unknown as ActivitySnapshot, candidate)) {
      pending.push({ isNew: false, id: existing.id, fields: candidate, fetchedAt });
    }
  }

  await db.transaction(async (tx) => {
    await acquireSyncWriteLock(tx);

    for (const write of pending) {
      if (write.isNew) {
        await tx.insert(garminActivities).values({
          id: write.id,
          ...write.fields,
          fetchedAt: write.fetchedAt,
          updatedAt: now,
          deletedAt: null,
          syncedAt: now,
          syncSeq: sql`nextval('sync_seq')`,
        });
        created += 1;
      } else {
        await tx
          .update(garminActivities)
          .set({
            ...write.fields,
            fetchedAt: write.fetchedAt,
            updatedAt: now,
            syncedAt: now,
            syncSeq: sql`nextval('sync_seq')`,
          })
          .where(eq(garminActivities.id, write.id));
        updated += 1;
      }
    }
  });

  return { scanned: list.length, created, updated, detailsFilled, mapsFilled };
}
