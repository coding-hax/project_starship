'use client';

import { startAuthentication } from '@simplewebauthn/browser';
import { useCallback, useState } from 'react';

export type AdminActionError = 'self' | 'not-found' | 'last-admin' | 'failed';

/**
 * Runs the step-up ceremony (#1224 AK10) and, only if it succeeds, sends
 * `method` to `url` with the assertion attached. A same-origin `fetch()` sends
 * `Origin` on every non-GET request on its own (AK6), nothing to add here.
 * Any failure — options request, a cancelled/rejected ceremony — throws
 * before `url` is ever reached, so `run()` below turns it into the generic
 * `failed` error without a destructive request having gone out.
 */
async function stepUpThenFetch(url: string, method: 'POST' | 'DELETE'): Promise<Response> {
  const optionsResponse = await fetch('/api/admin/step-up/options', { method: 'POST' });
  if (!optionsResponse.ok) throw new Error('step-up-options-failed');
  const options = await optionsResponse.json();

  const assertion = await startAuthentication({ optionsJSON: options });

  return fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ challenge: options.challenge, assertion }),
  });
}

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
    (id: string, onOk?: () => void) =>
      run(
        id,
        () =>
          fetch(`/api/admin/accounts/${id}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'block' }),
          }),
        onOk,
      ),
    [run],
  );

  const unblock = useCallback(
    (id: string, onOk?: () => void) =>
      run(
        id,
        () =>
          fetch(`/api/admin/accounts/${id}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'unblock' }),
          }),
        onOk,
      ),
    [run],
  );

  const reissue = useCallback(
    (id: string) => {
      setReissueLink(null);
      return run(
        id,
        () => stepUpThenFetch(`/api/admin/accounts/${id}/reissue`, 'POST'),
        (body) => {
          const link = (body as { link?: string } | null)?.link;
          if (link) setReissueLink({ id, link });
        },
      );
    },
    [run],
  );

  const deleteJournal = useCallback(
    (id: string) => run(id, () => stepUpThenFetch(`/api/admin/accounts/${id}/journal`, 'DELETE')),
    [run],
  );

  const deleteAccount = useCallback(
    (id: string) => run(id, () => stepUpThenFetch(`/api/admin/accounts/${id}`, 'DELETE')),
    [run],
  );

  return { busyId, error, reissueLink, block, unblock, reissue, deleteJournal, deleteAccount };
}
