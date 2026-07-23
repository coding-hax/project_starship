# ADR-0009: Externe Datenquellen — abrufen, lokal cachen, nie synchronisieren

Status: **angenommen** · Datum: 2026-07-23

## Kontext

Issue #139 bringt mit der Wettervorhersage die erste Fremdquelle ins Projekt
(Open-Meteo). Sie unterscheidet sich grundlegend von allem, was bisher durch
`src/local/` läuft: Wetterdaten gehören niemandem, sie sind nicht der Nutzer-
Inhalt, den Regel 8 und der Sync-Mechanismus (Outbox, `SYNC_REGISTRY`,
Postgres) schützen sollen. Trotzdem soll die UI — wie überall sonst — nie auf
ein `fetch` warten und nie direkt gegen eine externe API rendern.

Ohne festgehaltenes Muster würde der nächste Fall (z. B. der `.ics`-Import aus
ADR-0002) frei improvisieren: eigene Outbox-Altlasten, eigener Sync-Pfad oder
ein `fetch` direkt in einer Komponente. Alle drei wären falsch.

## Entscheidung

Externe, öffentliche Daten ohne Nutzerbezug bekommen eine eigene, rein lokale
Dexie-Ablage — **getrennt von `records`** — und folgen immer demselben Ablauf:

1. **Rendern kommt zuerst.** Die Komponente liest ausschließlich über eine
   Live-Query aus der lokalen Ablage (Regel 8 gilt für Fremdquellen genauso).
   Kein `fetch` in einer Komponente oder einem Hook, der UI rendert.
2. **Der Cache entscheidet, ob überhaupt geholt wird.** Ein Freshness-Fenster
   (bei Wetter: 3 Stunden, der Rechentakt des ICON-Modells) steuert, ob ein
   Refresh im Hintergrund losläuft. Innerhalb des Fensters passiert nichts.
3. **Ein Fehlschlag überschreibt nie einen bestehenden Eintrag.** Antwortet die
   Quelle nicht, bleibt der letzte bekannte Stand stehen. Gibt es noch keinen,
   zeigt die UI einen erklärenden Zustand — nie eine leere Fläche, nie einen
   rohen Fehler.
4. **Nie synchronisiert.** Die Tabelle taucht nicht in `SYNC_TABLES`
   (`src/db/sync-tables.ts`) auf, nicht in der Outbox, nicht in Postgres.
   Jedes Gerät holt selbst — es gibt nichts, was zwischen Geräten abzugleichen
   wäre.
5. **Der Service Worker liefert nie unbegrenzt aus dem Cache.** Cross-Origin-
   GET-Anfragen laufen bereits über `defaultCache`s `NetworkFirst`-Regel
   (`src/app/sw.ts` — kein Sonderfall nötig); Netz zuerst, Cache als Rückfall,
   nie umgekehrt.

## Konsequenzen

- `src/local/dexie.ts` bekommt für jede Fremdquelle eine eigene, typisierte
  Dexie-Tabelle statt eines weiteren Eintrags im generischen `records`-Store.
- Kein ADR-Bedarf für das Abrufen selbst, solange `fetch` genügt (Regel 3
  verlangt ein ADR erst bei einer neuen Dependency) — dieses ADR hält nur das
  Muster fest, nicht die konkrete Quelle.
- Der nächste Fall (z. B. `.ics`, ADR-0002) übernimmt diesen Ablauf, statt neu
  zu entscheiden, ob synchronisiert wird oder wo das `fetch` sitzen darf.
