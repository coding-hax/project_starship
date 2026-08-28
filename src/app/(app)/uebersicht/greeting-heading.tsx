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

const NBSP = ' ';

/**
 * Titel-Überschrift von /uebersicht (issue #862): eine Begrüßung nach Ortszeit
 * statt „Übersicht". Der Server kennt die Ortszeit des Geräts nicht — dasselbe
 * Hydration-Muster wie `TodayLongDate` (`useSyncExternalStore` mit `false`
 * als Server-Snapshot, `true` erst nach der Hydration), nur dass hier nicht der
 * Wert selbst, sondern nur die Hydration-Flanke darüberläuft; der Wert kommt aus
 * `useNow`, das per `setInterval` tickt und von Playwrights `page.clock` normal
 * weitergedreht wird (AK2).
 *
 * NBSP statt leerem String vor der Hydration: ein wirklich leeres h1 hat keine
 * Zeilenbox und damit Höhe 0, ein einzelnes NBSP dagegen belegt schon dieselbe
 * Zeilenhöhe wie die spätere Begrüßung — sonst wächst der Titel-Cluster beim
 * Hydration-Flip von 0 auf eine Zeile (CI-Fund AC1 aus
 * uebersicht-ladezustand.spec.ts). Die zweite Hälfte davon — den Umbruch auf
 * eine zweite Zeile bei „Guten Morgen"/„Guten Mittag" verhindern — übernimmt
 * `white-space: nowrap` auf `.uebersicht__title-cluster h1` in uebersicht.css.
 */
export function GreetingHeading() {
  const hydrated = useSyncExternalStore(subscribe, getHydratedSnapshot, getServerHydratedSnapshot);
  const now = useNow();

  return <h1>{hydrated ? greetingFor(now) : NBSP}</h1>;
}
