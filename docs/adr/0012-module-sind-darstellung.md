# ADR-0012: Module sind Darstellung, nie Datenhaltung

Status: **angenommen** · Datum: 2026-07-28

## Kontext

#216 (Recherche-Dach „Module zu-/abschaltbar") hat Entscheidung **B** getroffen:
Bereiche (Aufgaben, Gewohnheiten, Kalender, Journal, Aktivitäten) und
Zusatzmodule (Wetter, Export) sollen sich einzeln aus- und wieder einblenden
lassen, ohne dass ihre Daten verschwinden. Der unmittelbare Anlass sind die
toten Tabs Kalender/Journal — beide bis M4/M5 ohne Inhalt, aber fest in der
Nav sichtbar.

## Entscheidung

1. **Deklarative Registry, kein dynamischer Import/Code-Splitting.**
   `src/modules/registry.ts` ist die einzige Quelle je Modul (stabile `id`,
   `label`, `core`, optional `navItem`/`OverviewSection`/`SettingsPanel`/
   `routes`). `nav-items.ts` leitet `NAV_ITEMS` daraus ab, statt eine zweite
   Liste zu pflegen.
2. **Zustand ist eine `localStorage`-Ausschlussliste, nie Dexie/Outbox.**
   Schlüssel `starship:modules-off` trägt nur die **Aus**-Ids (Muster wie
   `use-nav-order.ts`), damit ein später ergänztes Modul auf jedem Gerät
   automatisch **an** startet, ohne dass ein Migrationsschritt nötig wird.
3. **Ein abgeschaltetes Modul synchronisiert unverändert weiter.** Der
   Schalter ist reine Darstellung — `SYNC_REGISTRY`/`src/db/`/`src/local/`
   bleiben unberührt, kein Tombstone, keine Dexie-Migration. Kein
   geschützter Pfad.
4. **`core` ist nie abwählbar:** Übersicht (`start_url` im Manifest zeigt
   dorthin) und Einstellungen (sonst könnte sich ein Nutzer aussperren).
5. **Guard läuft ausschließlich clientseitig, gefiltert wird beim Rendern.**
   Der Service Worker bleibt außen vor (`src/app/sw.ts` unangetastet, kein
   `localStorage` dort) und die gespeicherte Reihenfolge (`use-nav-order.ts`)
   bleibt vollständig erhalten — nur die Anzeige wird gekürzt, nie die
   Speicherung.

Export ist ein Sonderfall: Der Schalter versteckt nur das **Panel** in den
Einstellungen, nie die Export-Fähigkeit selbst (VISION-Prinzip 4 — Daten
müssen jederzeit portabel bleiben — gilt unverändert).

## Alternativen, verworfen

- **Echtes Plugin-System** (Lazy-Loading je Bereich) — bräuchte einen eigenen
  Ladezustand je Modul und widerspräche dem Produktprinzip „eine einzige,
  vorhersagbare App", ohne dass die Ladezeit einer Ein-Personen-PWA das
  rechtfertigt.
- **Zustand in Dexie statt `localStorage`** — würde einen geschützten Pfad
  (`src/local/`) für eine reine Anzeige-Präferenz öffnen und bei jedem
  Sync-Zyklus kurz aufflackern, bis der erste Pull durch ist.

## Konsequenzen

- Kein neues npm-Paket, keine ADR-Pflicht aus Regel 3.
- `nav-items.ts` ändert Name und Form von `NAV_ITEMS` nicht — bestehende
  Importe (`use-nav-order.ts`, `shell*.spec.ts`, `nav-order*.spec.ts`)
  bleiben unverändert.
- Folge-Tickets (T2/T3 aus #216) befüllen `OverviewSection`/`SettingsPanel`/
  `routes` in der Registry und wiren damit Wetter/Export/weitere Bereiche an
  denselben Schalter — dieses ADR gilt unverändert für sie mit.

## Risiken

Ein Modul, das aus- und wieder eingeschaltet wird, muss an derselben
Position wie zuvor erscheinen — sonst wirkt der Schalter wie ein
Reihenfolge-Reset. Da nur beim Rendern gefiltert wird und die gespeicherte
Reihenfolge nie verkürzt geschrieben wird, bleibt die Position automatisch
erhalten.
