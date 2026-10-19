'use client';

import { useCallback, useState } from 'react';

export type AdminActionError = 'self' | 'not-found' | 'last-admin' | 'failed';

/**
 * The write half of /admin (S5, #1204) — talks to `/api/admin/accounts/*`
 * directly, same reasoning as `use-admin-overview.ts`: this is server-
 * synchronous, not an outbox mutation. `reload` (from `useAdminOverview`)
 * is the caller's job to run after a successful action; this hook only
 * reports the outcome.
 */
export function useAdminActions(onDone: () => void) {
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<{ id: string; code: AdminActionError } | null>(null);
  const [reissueLink, setReissueLink] = useState<{ id: string; link: string } | null>(null);

  const run = useCallback(
    async (id: string, request: () => Promise<Response>, onOk?: (body: unknown) => void) => {
      setBusyId(id);
      setError(null);
      try {
        const response = await request();
        if (!response.ok) {
          const body = await response.json().catch(() => null);
          const code = body?.error;
          setError({
            id,
            code: code === 'self' || code === 'not-found' || code === 'last-admin' ? code : 'failed',
          });
          return;
        }
        onOk?.(await response.json().catch(() => null));
        onDone();
      } catch {
        setError({ id, code: 'failed' });
      } finally {
        setBusyId(null);
      }
    },
    [onDone],
  );

  const block = useCallback(
    (id: string) =>
      run(id, () =>
        fetch(`/api/admin/accounts/${id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'block' }),
        }),
      ),
    [run],
  );

  const unblock = useCallback(
    (id: string) =>
      run(id, () =>
        fetch(`/api/admin/accounts/${id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'unblock' }),
        }),
      ),
    [run],
  );

  const reissue = useCallback(
    (id: string) => {
      setReissueLink(null);
      return run(
        id,
        () => fetch(`/api/admin/accounts/${id}/reissue`, { method: 'POST' }),
        (body) => {
          const link = (body as { link?: string } | null)?.link;
          if (link) setReissueLink({ id, link });
        },
      );
    },
    [run],
  );

  const deleteJournal = useCallback(
    (id: string) => run(id, () => fetch(`/api/admin/accounts/${id}/journal`, { method: 'DELETE' })),
    [run],
  );

  const deleteAccount = useCallback(
    (id: string) => run(id, () => fetch(`/api/admin/accounts/${id}`, { method: 'DELETE' })),
    [run],
  );

  return { busyId, error, reissueLink, block, unblock, reissue, deleteJournal, deleteAccount };
}
