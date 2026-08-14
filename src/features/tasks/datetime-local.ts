/**
 * `datetime-local` inputs work in the browser's local time, with no timezone
 * suffix — one shared conversion for every task sheet that offers a Fälligkeit,
 * so the create and the edit path can never drift apart on it.
 */
export function isoToLocalInput(iso: string | null): string {
  if (!iso) return '';
  const date = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** `''` (the empty input) means "no due date", not "epoch". */
export function localInputToIso(value: string): string | null {
  return value ? new Date(value).toISOString() : null;
}

/** `"Donnerstag 14:00"` for the Wann-Chip's value (issue #711 AK6) — works on
 * both an ISO instant and the bare local string `dueAt` is otherwise kept in,
 * since neither carries an offset that would shift the parsed instant. */
export function formatDueLabel(value: string): string {
  const date = new Date(value);
  const weekday = date.toLocaleDateString('de-DE', { weekday: 'long' });
  const time = date.toLocaleTimeString('de-DE', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  return `${weekday} ${time}`;
}
