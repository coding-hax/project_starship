/**
 * The one place feature code speaks to `/api/ics` (issue #560, ADR-0022) —
 * check-sync-invariants.sh only excuses `src/local/**`, same reasoning as
 * `push.ts` for `/api/push`. The proxy itself does the SSRF
 * validation (`src/app/api/ics/route.ts`); this is just the thin client call.
 */

/** Resolves with the fetched `.ics` text; throws on any non-2xx status. */
export async function fetchIcsText(url: string): Promise<string> {
  const response = await fetch(`/api/ics?url=${encodeURIComponent(url)}`);
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    const message = typeof body?.error === 'string' ? body.error : `Status ${response.status}`;
    throw new Error(message);
  }
  return response.text();
}
