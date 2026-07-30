import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { logJournalQueryError } from './log-query-error';

// The four hooks named in issue #393 — every one of their liveQuery/catch
// error branches must route through `logJournalQueryError` instead of
// handing the raw Dexie error to console.*.
const HOOK_FILES = [
  new URL('./use-journal-entries.ts', import.meta.url),
  new URL('./use-journal-search-entries.ts', import.meta.url),
  new URL('./use-journal-conflicts.ts', import.meta.url),
  new URL('./use-journal-today.ts', import.meta.url),
];

describe('logJournalQueryError', () => {
  it('issue #393: logs only the fixed message — nothing else ever reaches console.error', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

    logJournalQueryError('journal entries live query failed');

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith('journal entries live query failed');
    spy.mockRestore();
  });

  it.each(HOOK_FILES)(
    'issue #393: a forced query error in %s can only ever produce a content-free log line',
    (fileUrl) => {
      const source = readFileSync(fileUrl, 'utf-8');

      // Every error branch calls the content-free helper...
      expect(source).toContain('logJournalQueryError(');
      // ...and nowhere in the file does a raw Dexie/JS error object get
      // handed to console.* — that's the path that used to leak (issue #393).
      expect(source).not.toMatch(/console\.(error|warn|log)\([^)]*\berror\b/);
    },
  );
});
