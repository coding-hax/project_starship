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
