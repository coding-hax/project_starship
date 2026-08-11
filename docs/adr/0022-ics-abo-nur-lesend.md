# ADR-0022: ICS-Abo nur lesend — Parser-Teilmenge, SSRF-Modell, Pull-Takt

Status: **angenommen** · Datum: 2026-08-11 · Bezug: #560 (S9 von #473), ADR-0009

Schließt die Lücke, die ADR-0009 und Epic #473 wiederholt als „ADR-0002"
bezeichnen — dieses ADR wurde nie geschrieben, die Nummer 0002 existiert nicht
in `docs/adr/`. Dieses Dokument ist die faktische Entscheidung dazu, unter der
nächsten freien Nummer.

## Kontext

Issue #560 bringt externe `.ics`-Kalender (Feiertage, geteilte Kalender)
schreibgeschützt in die Timeline. Die Recherche im Ticket hat die Entscheidung
**A** getroffen: nur **ganztägige** Termine (Feiertage) müssen korrekt
dargestellt werden, keine getimten Termine mit fremder Zeitzone (`TZID`/DST).
Damit entfällt der Bedarf für eine Parser-Dependency wie `ical.js`.

Drei Fragen brauchten eine Entscheidung, bevor Code entsteht: welche
RFC-5545-Teilmenge ein eigener Parser abdeckt, wie der server-seitige Proxy
gegen SSRF abgesichert wird, und wann/wo der Pull läuft.

## Entscheidung

### 1. Parser-Teilmenge (bewusst, nicht vollständig)

Ein eigener Minimal-Parser (`src/features/events/ics-parse.ts`), kein
`ical.js`, keine neue Dependency (Regel 3 bleibt unberührt). Abgedeckt:

- Zeilenentfaltung nach RFC 5545 §3.1 (gefaltete Zeilen mit führendem
  Leerzeichen/Tab gehören zur vorigen Zeile).
- `VEVENT`-Blöcke, daraus `UID`, `SUMMARY`, `DTSTART;VALUE=DATE`,
  `DTEND;VALUE=DATE` (fehlt `DTEND`, gilt `DTSTART` als einziger Tag),
  `RRULE` (Teilmenge `FREQ`/`INTERVAL`/`COUNT`/`UNTIL`/`BYDAY`), `EXDATE`.

**Bewusst überlesen, nie geraten:**

- Jede Property, die dieser Parser nicht kennt (`VALARM`, `LOCATION`,
  `DESCRIPTION`, `VTIMEZONE`, …) — ignoriert, nie ein Abbruch.
- **Getimte Termine** (`DTSTART` mit Uhrzeit/`TZID`, kein `VALUE=DATE`)
  fallen komplett heraus — kein Best-Effort-Zeitzonen-Handling, das im
  Zweifel falsch verschiebt. Genau die in der Recherche identifizierte
  Grenze der Entscheidung A.
- Ein `RRULE`, dessen `FREQ` nicht in `{daily, weekly, monthly, yearly}`
  liegt (z. B. `SECONDLY`), wird als Einzeltermin am `DTSTART`-Tag
  behandelt, keine Serie.

### 2. SSRF-Modell für den Proxy (`src/app/api/ics/route.ts`)

Der Proxy holt eine vom Nutzer eingetragene URL serverseitig ab — die
klassische SSRF-Fläche (Heimnetz, Cloud-Metadaten). Absicherung, kumulativ,
in `src/app/api/ics/ssrf.ts` (reine Funktionen, kein Netz, Vitest-testbar):

- **Schema-Allowlist:** nur `https`.
- **IP-Sperre auf der aufgelösten Adresse:** `dns.promises.lookup(host, { all: true })`,
  **jede** zurückgegebene Adresse gegen eine Sperrliste geprüft (loopback,
  private, link-local, Cloud-Metadaten `169.254.169.254`, `::1`, ULA
  `fc00::/7`) — verweigert, wenn auch nur eine Adresse gesperrt ist.
- **Redirects manuell:** `fetch(url, { redirect: 'manual' })`, ein `3xx`
  liest `Location`, validiert die neue URL **erneut vollständig** (Schema +
  DNS + IP-Sperre), höchstens 5 Hops — kein automatisches Redirect-Folgen,
  das die Prüfung umgehen könnte.
- **Harte Grenzen:** Timeout (`AbortSignal.timeout`) und ein Größen-Cap
  (~5 MB) beim Streamen des Bodys.
- **Owner-Gate:** `requireOwner()` Pflicht — kein Cron-Pfad, kein offenes
  Relay für Dritte.

**Akzeptiertes Restrisiko:** TOCTOU/DNS-Rebinding zwischen `dns.lookup` und
dem tatsächlichen `fetch`-Verbindungsaufbau — die Adresse könnte sich in der
kurzen Lücke ändern. „Pin resolution" (Hostname→IP auflösen, IP validieren,
per IP mit Host-Header verbinden) wäre robuster, aber deutlich fummeliger mit
TLS-SNI und für eine Ein-Personen-App mit eigenhändig eingetragenen URLs nicht
im Verhältnis. Rückweg bei Bedarf: `route.ts` um Pin-Resolution erweitern,
ohne den Aufrufer (`src/local/ics-fetch.ts`) zu ändern — der Vertrag
(„liefert `text/calendar` oder lehnt ab") bleibt gleich.

### 3. Pull-Takt: client-getrieben, kein Server-Cron

Wie die Wettervorhersage (ADR-0009): die UI liest ausschließlich aus Dexie,
ein Hook (`use-ics-subscriptions.ts`) prüft bei Fokus/Sichtbarkeit/Intervall,
ob der Cache älter als ein Freshness-Fenster ist, und holt dann über den
Proxy nach. Kein Server-Cron — der bestehende Cron-Pfad
(`.github/workflows/reminders.yml`) hängt an Repo-Secrets, die dieses Repo
nicht hat, und könnte ohnehin nicht in die client-lokale Dexie schreiben
(Local-first, Regel 8).

Freshness-Fenster: 6 Stunden. Feiertage ändern sich praktisch nie, geteilte
Kalender sind mit „binnen eines Tages sichtbar" gut bedient — deutlich
großzügiger als Wetter (3 Stunden), da hier kein Live-Zustand hängt.

### 4. Speicher: eigene Dexie-Tabelle, nie synchronisiert

Neue Tabelle `icsSubscriptions` in `src/local/dexie.ts` (additiver
`db.version(7)`-Bump), eine Zeile je Abo — Konfiguration (URL, Name) und
Cache (letzte erfolgreich geholten Termine) in derselben Zeile, wie
`WeatherCacheEntry`. Serien werden **beim Pull** auf einen gedeckelten
Horizont (−1 Monat … +12 Monate um heute) zu flachen Einzelterminen
expandiert und als solche abgelegt — nicht als App-eigene `recurrence`
(die wäre editierbar, hier aber ausdrücklich nicht gewollt).

Diese Tabelle taucht **nicht** in `SYNC_TABLES` auf, nie in der Outbox, nie
in Postgres (ADR-0009, Regel 4/8/9 sinngemäß — hier keine Nutzerinhalte,
aber dieselbe Local-first-Grenze). Ein Fehlschlag beim Pull überschreibt nur
ein `lastError`-Feld, nie die zuletzt erfolgreich geholten `events`.

Die Timeline liest synced `events` und `icsSubscriptions` getrennt und
merged sie über ein reines View-Feld `origin: 'local' | 'subscribed'`
(`EventView`/`Occurrence`) — keine Schema-Spalte. Der Editor
(`calendar-view.tsx`'s `openEdit`) sucht ausschließlich in `events`, ein
Tap auf ein abonniertes Item findet dort nichts und öffnet keinen Editor —
schreibgeschützt folgt strukturell daraus, statt separat erzwungen zu
werden.

## Verworfen — bitte nicht erneut vorschlagen

- **`ical.js`/`node-ical` als Dependency.** Für die auf ganztägige Termine
  begrenzte Entscheidung A unverhältnismäßig — voller RFC-5545/VTIMEZONE-
  Support für eine Teilmenge, die keine Zeitzonen braucht. Wird relevant,
  sobald getimte `TZID`-Termine gefordert werden (Entscheidung B, nicht
  getroffen).
- **Pin-Resolution (Hostname→IP, per IP verbinden) als Erstumsetzung.**
  Robuster gegen DNS-Rebinding, aber TLS-SNI-Komplexität, die für die
  Bedrohungslage (Ein-Personen-App, selbst eingetragene URLs) nicht im
  Verhältnis steht. Siehe Restrisiko oben für den Rückweg.
- **Server-Cron für den Pull.** Hängt an Repo-Secrets, die nicht existieren,
  und kann lokale Dexie ohnehin nicht befüllen (Local-first).
- **Abonnierte Termine in der `events`-Tabelle.** Die würde synchronisiert
  und wäre editierbar — beides falsch für extern geholte, schreibgeschützte
  Daten.

## Risiko / Rückweg

Sensibler Pfad (`src/app/api/`, geschützter Pfad laut CLAUDE.md). Ein Fehler
in der SSRF-Prüfung wäre kein kosmetischer Bug, sondern ein Zugriff auf
internes Netz/Cloud-Metadaten über den eigenen Server. `ssrf.ts` ist bewusst
reine, Netz-freie Logik — Vitest deckt die Sperrliste direkt ab, ohne DNS/
Netz zu mocken. Rückweg bei einem gefundenen Loch: additiv, die Route lehnt
im Zweifel ab (fail closed) statt offen — ein Bug hier führt zu einem
verweigerten Abo-Refresh, nicht zu einem stillen Leck.

## Nicht-Ziele

Kein Zwei-Wege-Sync, kein Editor-Zugriff auf abonnierte Termine, keine
getimten/`TZID`-Termine (Entscheidung A), kein Datei-Import (das ist #9).
