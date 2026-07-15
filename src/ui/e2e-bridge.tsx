'use client';

import { useEffect } from 'react';
import { mutate, pending, size } from '@/local/outbox';
import { startSync, sync } from '@/local/sync';

/**
 * A handle on the real outbox for the E2E suite.
 *
 * M0 has no feature UI yet, so there is nothing that can write a mutation — but the
 * acceptance criterion ("outbox takes a mutation, survives a reload, reaches Postgres")
 * has to be tested against the real thing, not a mock. This exposes the actual
 * outbox and sync functions, the same ones the tasks UI will call in M1.
 *
 * Only rendered when NEXT_PUBLIC_E2E=1, which is set by the Playwright web server
 * and by nothing else. It is not in the production bundle.
 */
export function E2EBridge() {
  useEffect(() => {
    Object.assign(window, {
      __starship: { mutate, sync, pending, size, startSync },
    });
  }, []);

  return null;
}
