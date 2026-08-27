'use client';

import { useSyncExternalStore } from 'react';
import { useNow } from '@/ui/use-now';
import { greetingFor } from './greeting';

function subscribe() {
  return () => {};
}

function getHydratedSnapshot() {
  return true;
}

function getServerHydratedSnapshot() {
  return false;
}

/**
 * Titel-Überschrift von /uebersicht (issue #862): eine Begrüßung nach Ortszeit
 * statt „Übersicht". Der Server kennt die Ortszeit des Geräts nicht — dasselbe
 * Hydration-Muster wie `JournalHeaderDate` (`useSyncExternalStore` mit `false`
 * als Server-Snapshot, `true` erst nach der Hydration), nur dass hier nicht der
 * Wert selbst, sondern nur die Hydration-Flanke darüberläuft; der Wert kommt aus
 * `useNow`, das per `setInterval` tickt und von Playwrights `page.clock` normal
 * weitergedreht wird (AK2).
 */
export function GreetingHeading() {
  const hydrated = useSyncExternalStore(subscribe, getHydratedSnapshot, getServerHydratedSnapshot);
  const now = useNow();

  return <h1>{hydrated ? greetingFor(now) : ''}</h1>;
}
