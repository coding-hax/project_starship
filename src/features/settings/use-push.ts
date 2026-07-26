'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  getPushState,
  sendTestPush,
  subscribeToPush,
  unsubscribeFromPush,
  type PushState,
} from '@/local/push';

type Phase = 'loading' | PushState;

/** Thin wrapper around src/local/push.ts — this hook never calls fetch itself. */
export function usePush() {
  const [phase, setPhase] = useState<Phase>('loading');
  const [busy, setBusy] = useState(false);
  const [testSent, setTestSent] = useState(false);

  useEffect(() => {
    let cancelled = false;
    getPushState().then((state) => {
      if (!cancelled) setPhase(state);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const activate = useCallback(async () => {
    setBusy(true);
    setTestSent(false);
    try {
      setPhase(await subscribeToPush());
    } finally {
      setBusy(false);
    }
  }, []);

  const deactivate = useCallback(async () => {
    setBusy(true);
    setTestSent(false);
    try {
      await unsubscribeFromPush();
      setPhase(await getPushState());
    } finally {
      setBusy(false);
    }
  }, []);

  const sendTest = useCallback(async () => {
    setBusy(true);
    try {
      await sendTestPush();
      setTestSent(true);
    } finally {
      setBusy(false);
    }
  }, []);

  return { phase, busy, testSent, activate, deactivate, sendTest };
}
