# Code-Karte: Wetter

## src/features/weather

- `forecast.ts` — Open-Meteo: laden/parsen, Stale-Erkennung, Tagesdetail
- `geocoding.ts` / `geolocation.ts` / `wmo-icon.ts` / `weather-category-labels.ts` — Ortssuche, GPS, Wettercode zu Icon
- `use-weather-cache.ts` / `use-weather-forecast.ts` / `use-weather-day.ts` — Lese-Hook, Refresh, Tagesdetail
- `weather-forecast.tsx` / `.css` / `weather-day.tsx` / `.css` — 7-Tage-Streifen + Tagesdetail
