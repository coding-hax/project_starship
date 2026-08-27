'use client';

import { useCallback, useSyncExternalStore } from 'react';

export interface WeatherLocation {
  name: string;
  latitude: number;
  longitude: number;
}

const LOCATION_KEY = 'starship:weather-location';

/** Ohne Zutun gilt weiterhin Bonn (issue #159 AC2) — dieselben Koordinaten wie zuvor
 * fest in forecast.ts. */
export const DEFAULT_WEATHER_LOCATION: WeatherLocation = {
  name: 'Bonn',
  latitude: 50.7374,
  longitude: 7.0982,
};

/** Angezeigter Name für einen per GPS gesetzten Ort (issue #853) — kein
 * Reverse-Geocoding, siehe Ticket „Nicht-Ziele". */
export const CURRENT_LOCATION_NAME = 'Aktueller Standort';

function isWeatherLocation(value: unknown): value is WeatherLocation {
  const candidate = value as Partial<WeatherLocation> | null;
  return (
    !!candidate &&
    typeof candidate.name === 'string' &&
    typeof candidate.latitude === 'number' &&
    typeof candidate.longitude === 'number'
  );
}

function readLocation(): WeatherLocation {
  const raw = localStorage.getItem(LOCATION_KEY);
  if (!raw) return DEFAULT_WEATHER_LOCATION;
  try {
    const parsed = JSON.parse(raw);
    return isWeatherLocation(parsed) ? parsed : DEFAULT_WEATHER_LOCATION;
  } catch {
    return DEFAULT_WEATHER_LOCATION;
  }
}

let cache: WeatherLocation | null = null;
const listeners = new Set<() => void>();

function getSnapshot(): WeatherLocation {
  if (cache === null) {
    cache = readLocation();
  }
  return cache;
}

function getServerSnapshot(): WeatherLocation {
  return DEFAULT_WEATHER_LOCATION;
}

function subscribe(onStoreChange: () => void) {
  listeners.add(onStoreChange);
  return () => listeners.delete(onStoreChange);
}

/**
 * Geräte-lokale Ortseinstellung fürs Wetter (issue #159), gleiches Muster wie
 * use-appearance.ts / use-capture-prefs.ts: keine synchronisierte Domänen-Mutation
 * (CLAUDE.md Regel 8 gilt fürs Schreiben von App-Daten, nicht für diese
 * Anzeige-Präferenz) — welchen Ort man sehen will, kann sich vom Handy unterscheiden.
 */
export function useWeatherLocation() {
  const location = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  const setLocation = useCallback((next: WeatherLocation) => {
    localStorage.setItem(LOCATION_KEY, JSON.stringify(next));
    cache = next;
    for (const listener of listeners) listener();
  }, []);

  return { location, setLocation };
}
