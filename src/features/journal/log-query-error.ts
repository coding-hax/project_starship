/**
 * The `error` callback of a Dexie `liveQuery` subscription fires on
 * query-engine failures (schema mismatch, aborted transaction, driver error).
 * Nothing here can vouch for those error objects never echoing a
 * where-clause value or a row's data (Regel 9), so the error itself is never
 * forwarded to the console — callers pass only a fixed, content-free message.
 */
export function logJournalQueryError(message: string): void {
  console.error(message);
}
