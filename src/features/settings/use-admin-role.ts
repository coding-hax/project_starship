'use client';

import { useEffect, useState } from 'react';

/**
 * Whether the signed-in account is `role: 'admin'` (S4, #1203 AK10) — read from
 * `/api/auth/status`, which already carries `role` for an authenticated session
 * (no new endpoint). Starts `false` and *stays* `false` on any failure (offline,
 * non-OK response, no session): AK10 explicitly allows the "Verwaltung" entry
 * to be missing when the server can't be asked, same as /admin itself needing
 * network anyway.
 */
export function useIsAdmin(): boolean {
  const [isAdmin, setIsAdmin] = useState(false);

  // queueMicrotask, not a direct call: react-hooks/set-state-in-effect flags a
  // synchronous call to a setState-calling function from the effect body itself
  // (same pattern as use-sessions.ts/quick-add.tsx).
  useEffect(() => {
    queueMicrotask(() => {
      fetch('/api/auth/status')
        .then((response) => (response.ok ? response.json() : null))
        .then((status: { role?: string } | null) => setIsAdmin(status?.role === 'admin'))
        .catch(() => {});
    });
  }, []);

  return isAdmin;
}
