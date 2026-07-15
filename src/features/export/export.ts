import { db, type LocalRecord } from '@/local/dexie';

/**
 * Bumped whenever `ExportPayload`'s shape changes, so a future importer can tell
 * which version it is reading instead of guessing.
 */
export const EXPORT_SCHEMA_VERSION = 1;

export interface ExportPayload {
  schemaVersion: number;
  exportedAt: string;
  records: LocalRecord[];
}

/**
 * Reads straight from IndexedDB (CLAUDE.md rule 8) — this is why the export works
 * offline, it never touches the network. `records` already carries tombstones
 * (`deletedAt` set instead of a row removal), so nothing needs filtering here.
 */
export async function buildExport(): Promise<ExportPayload> {
  const records = await db.records.toArray();
  return {
    schemaVersion: EXPORT_SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    records,
  };
}

export function exportFilename(now: Date): string {
  return `starship-export-${now.toISOString().slice(0, 10)}.json`;
}

/** Builds the export and triggers a browser download. */
export async function downloadExport(): Promise<void> {
  const payload = await buildExport();
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = exportFilename(new Date());
  link.click();
  // Revoked on the next tick, not synchronously — the download has to actually start
  // reading the blob URL first.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
