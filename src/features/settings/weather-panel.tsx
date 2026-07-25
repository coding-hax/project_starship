'use client';

import { useId, useRef, useState, type FormEvent } from 'react';
import { formatGeocodingResult, searchLocations, type GeocodingResult } from '@/features/weather/geocoding';
import { Row } from '@/ui/row';
import { SectionCard } from '@/ui/section-card';
import { useWeatherLocation } from './use-weather-location';

type SearchPhase = 'idle' | 'loading' | 'results' | 'empty' | 'error';

/**
 * Ort für die Wettervorhersage (issue #159) + Open-Meteo-Quellenangabe (issue #155
 * AC5) — dieselbe Fremdquelle, deshalb eine gemeinsame Tafel statt zweier. Die Suche
 * ist bewusst flüchtig: Treffer landen nur im Component-State, nie in Dexie
 * (geocoding.ts) — nur der gewählte Ort geht über use-weather-location.ts in
 * localStorage.
 */
export function WeatherPanel() {
  const { location, setLocation } = useWeatherLocation();
  const [query, setQuery] = useState('');
  const [phase, setPhase] = useState<SearchPhase>('idle');
  const [results, setResults] = useState<GeocodingResult[]>([]);
  const [lastQuery, setLastQuery] = useState('');
  const requestIdRef = useRef(0);
  const inputId = useId();

  async function handleSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = query.trim();
    if (!trimmed) return;

    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    setPhase('loading');

    try {
      const found = await searchLocations(trimmed);
      if (requestIdRef.current !== requestId) return;
      setLastQuery(trimmed);
      setResults(found);
      setPhase(found.length === 0 ? 'empty' : 'results');
    } catch {
      if (requestIdRef.current !== requestId) return;
      setResults([]);
      setPhase('error');
    }
  }

  function handleSelect(result: GeocodingResult) {
    setLocation({ name: result.name, latitude: result.latitude, longitude: result.longitude });
    setResults([]);
    setQuery('');
    setPhase('idle');
  }

  return (
    <SectionCard title="Wetter">
      <Row label="Aktueller Ort">
        <span>{location.name}</span>
      </Row>

      <form className="weather-panel__search" onSubmit={handleSearch}>
        <label htmlFor={inputId} className="weather-panel__search-label">
          Ort suchen
        </label>
        <div className="weather-panel__search-row">
          <input
            id={inputId}
            type="text"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="z. B. Berlin"
            className="weather-panel__search-input"
          />
          <button type="submit" className="weather-panel__search-submit">
            Suchen
          </button>
        </div>
      </form>

      {phase === 'loading' && <p className="weather-panel__status">Suche läuft …</p>}
      {phase === 'error' && (
        <p className="weather-panel__status">Ohne Netz kann kein Ort gesucht werden.</p>
      )}
      {phase === 'empty' && (
        <p className="weather-panel__status">Keine Treffer für „{lastQuery}“.</p>
      )}
      {phase === 'results' && (
        <ul className="weather-panel__results">
          {results.map((result) => (
            <li key={`${result.latitude},${result.longitude}`}>
              <button
                type="button"
                className="weather-panel__result"
                onClick={() => handleSelect(result)}
              >
                {formatGeocodingResult(result)}
              </button>
            </li>
          ))}
        </ul>
      )}

      <Row label="Wetterdaten">
        <a href="https://open-meteo.com/" target="_blank" rel="noreferrer">
          Open-Meteo
        </a>
      </Row>
    </SectionCard>
  );
}
