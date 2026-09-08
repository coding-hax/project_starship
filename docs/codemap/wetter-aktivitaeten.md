# Code-Karte: Wetter, Aktivitäten, Garmin

## src/features/activities

- `recap.ts` / `monthly-summary.ts` — 30-Tage-Recap + Monatszusammenfassung je Art
- `format.ts` / `track-path.ts` / `line-path.ts` — Formatierung + SVG-Geometrie für Wertreihen
- `use-activities.ts` / `use-activity-sync.ts` — Live-Query, stößt den Garmin-Sync an
- `activity-list.tsx` / `.css` / `activity-block.tsx` / `.css` — Recap+Liste, Kopfzahlen und Kurven
- `activity-map.tsx` / `.css` / `activity-chart.tsx` / `.css` — Kartenbild und Kurve (HF/Pace/Höhe)
- `activity-month-strip.tsx` / `.css` — Monatsstand auf der Übersicht

## src/features/garmin

- `connect-api.ts` / `tokens.ts` — OAuth1-Signatur + OAuth2-Tausch und -Erneuerung
- `activity-mapper.ts` / `activity-diff.ts` / `static-map.ts` — Rohform zu Kopfzahlen/Track, Diff, Kartenbild
- `sync-activities.ts` — kompletter Ablauf in einer Schreib-Transaktion

## src/features/weather

- `forecast.ts` — Open-Meteo: laden/parsen, Stale-Erkennung, Tagesdetail
- `geocoding.ts` / `geolocation.ts` / `wmo-icon.ts` / `weather-category-labels.ts` — Ortssuche, GPS, Wettercode zu Icon
- `use-weather-cache.ts` / `use-weather-forecast.ts` / `use-weather-day.ts` — Lese-Hook, Refresh, Tagesdetail
- `weather-forecast.tsx` / `.css` / `weather-day.tsx` / `.css` — 7-Tage-Streifen + Tagesdetail
