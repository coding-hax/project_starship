'use client';

import { useEffect, useState } from 'react';

/**
 * A `Date` that re-renders its caller every `intervalMs` — the tick behind the
 * calendar's now-line (issue #553), generic enough for any other "stays current
 * without a reload" need. `page.clock` in Playwright still drives real
 * `setInterval` calls, so a fast-forwarded fake clock advances this normally.
 */
export function useNow(intervalMs = 60_000): Date {
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);

  return now;
}
