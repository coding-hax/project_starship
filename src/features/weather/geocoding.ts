export interface GeocodingResult {
  name: string;
  admin1?: string;
  country?: string;
  latitude: number;
  longitude: number;
}

interface OpenMeteoGeocodingResponse {
  results?: Array<{
    name: string;
    admin1?: string;
    country?: string;
    latitude: number;
    longitude: number;
  }>;
}

/**
 * Ort-Suche für die Auswahl in den Einstellungen (issue #159). Bewusst flüchtig:
 * Treffer werden nur angezeigt, nie in Dexie abgelegt — ADR-0009 (rendern nur aus dem
 * lokalen Cache) gilt für die Vorhersage selbst, nicht für diese Suchergebnisse.
 * Niemand soll das später "reparieren", indem er Suchtreffer mitcacht.
 */
export async function searchLocations(query: string): Promise<GeocodingResult[]> {
  const url =
    `https://geocoding-api.open-meteo.com/v1/search` +
    `?name=${encodeURIComponent(query)}&count=5&language=de&format=json`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Open-Meteo-Geocoding antwortete mit Status ${response.status}`);
  }
  const body: OpenMeteoGeocodingResponse = await response.json();
  return (body.results ?? []).map((result) => ({
    name: result.name,
    admin1: result.admin1,
    country: result.country,
    latitude: result.latitude,
    longitude: result.longitude,
  }));
}

/** "Bonn, Nordrhein-Westfalen, Deutschland" — nur die Teile, die die Antwort mitliefert. */
export function formatGeocodingResult(result: GeocodingResult): string {
  return [result.name, result.admin1, result.country].filter(Boolean).join(', ');
}
