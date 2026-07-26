# ADR-0011: Garmin — Bootstrap im Browser, Betrieb per Token, kein Anmeldecode im Server

Status: **angenommen** · Datum: 2026-07-26

## Kontext

Garmin bietet Einzelpersonen keinen offiziellen API-Zugang: Das Garmin Connect
Developer Program (Health API) ist derzeit ausgesetzt, keine neuen
Entwicklerkonten. Zulassung würde ohnehin Firma, Firmen-Domain-Mail,
öffentliche Datenschutzerklärung und einen Integrations-Call voraussetzen —
für eine Ein-Personen-App kein Weg.

Der bisher übliche inoffizielle Weg — Anmeldung an `sso.garmin.com` mit
eigenen Zugangsdaten über Libs wie `garth`/`garminconnect` — ist seit März
2026 gesperrt: Garmin blockt automatisierte Logins per
Cloudflare-TLS-Fingerprinting (429 auf `/mobile/api/login`), und `garth`,
die führende Bibliothek dieser Familie, wurde am 27.03.2026 vom Autor
eingestellt.

Blockiert ist nur das **Anmelden**, nicht das **Abrufen**: Mit einem gültigen
Token liefert `connectapi.garmin.com` weiterhin normal. Ein Browser-Login
funktioniert weiter und liefert ein Service-Ticket, das sich in ein
OAuth1-Token tauschen lässt (Standzeit ≈ 1 Jahr), aus dem laufend frische
OAuth2-Tokens (≈ 1 Stunde, automatischer Refresh) erzeugt werden.

Geprüfte Node-Bibliotheken (`@flow-js/garmin-connect`, `@gooin/garmin-connect`,
das ursprüngliche `garmin-connect`) bringen entweder unnötige Fremdpakete mit
(u. a. ein npm-Platzhalterpaket `crypto`, das den Node-Builtin verschattet,
oder `redis`/`ioredis`/`@upstash/redis` als Vendor-Primitiv — Konflikt mit
Regel 7) oder sind seit Anfang 2024 unverändert. Ihr einziger Wert ist der
Login-Flow — genau das kaputte Stück. Was tatsächlich gebraucht wird, ist ein
POST für den Token-Refresh und eine Handvoll GETs mit
`Authorization: Bearer …` gegen dokumentierte JSON-Endpunkte: eigener
`fetch`-Code statt neuer Dependency.

Präzedenzfall im Repo: ADR-0009 (externe Datenquellen lokal cachen, am
Beispiel Wetter). Garmin-Daten sind dieselbe Kategorie — Server-Origin-Daten,
kein Nutzer-Inhalt —, nur dass hier zusätzlich Tokens verwaltet werden
müssen, was ADR-0009 für den zustandslosen Wetter-Fall nicht behandelt.

## Entscheidung

1. **Die App meldet sich nie selbst an.** Es gibt keinen Anmeldecode und kein
   Garmin-Passwort im Server, im Repo oder in einem Secret-Store.
2. **Der Bootstrap ist ein manueller Schritt eines Menschen:** Anmeldung im
   Browser, Service-Ticket abgreifen, in OAuth1/OAuth2 tauschen, Tokens
   einmalig hinterlegen. Fällig etwa einmal jährlich — ein Skript unter
   `scripts/` darf dabei helfen, aber nie automatisch laufen.
3. **Der Betrieb ist tokenbasiert:** Der Sync-Endpunkt erneuert das
   OAuth2-Token aus dem OAuth1-Token und schreibt das erneuerte Token zurück
   in Postgres. Läuft OAuth1 ab, meldet die App das sichtbar und hält an —
   sie rät nicht und probiert keine Anmeldung.
4. **Kein Client der Bibliotheken.** Der Zugriff läuft über eigenen
   `fetch`-Code gegen `connectapi.garmin.com`; die MIT-lizenzierten Libs
   dienen als Referenz für Endpunktpfade, nicht als Dependency (Regeln 3
   und 7).
5. **Garmin-Daten sind Server-Origin-Daten und laufen nicht durch die
   Outbox:** GitHub-Actions-Cron → `/api/garmin-sync` (Shared Secret) →
   Postgres → normaler Pull → IndexedDB → UI. Kein Vercel-Cron (Regel 7,
   Hobby-Limits) — Hintergrundjobs laufen in diesem Projekt grundsätzlich
   über Actions-Cron. Für die UI gilt ADR-0009 unverändert: nur Live-Query
   aus der lokalen Ablage, ein Fehlschlag überschreibt nie einen bestehenden
   Stand.
6. **Tokens werden nie geloggt**, weder ganz noch gekürzt.

### Metriken — Stufe 1: Aktivitäten

Nicht Tagessummen (Schritte/Schlaf/Ruhepuls) — die bekommen ein eigenes
Ticket, sobald Journal oder Gewohnheiten sie tatsächlich anzeigen. Stufe 1
ist die Aktivitäten-Ansicht:

- Ein **30-Tage-Recap** oben (Anzahl Aktivitäten, Kilometer), gerechnet aus
  den lokal liegenden Aktivitäten — kein eigener Endpunkt-Aufruf dafür.
- Darunter je Aktivität ein Block mit Karte, Kopfzahlen (Distanz, Ø-Pace,
  Höhenmeter, Ø-HF, Pausen) und Kurven für HF, Pace und Höhenprofil.

Zwei Endpunkte decken das ab, dieselbe Token-Mechanik wie oben:

- `/activitylist-service/activities/search/activities` — Kopfzahlen, deckt
  auch den Recap ab.
- `/activity-service/activity/{id}/details?maxChartSize=500&maxPolylineSize=500`
  — Koordinaten, HF, Tempo, Höhe in einem Aufruf.

### Karte: Standbild, einmal serverseitig

Garmin liefert Koordinaten, keine Karte. Der Sync-Endpunkt holt pro
Aktivität **einmal** ein Standbild von einem Kartendienst (API-Key nur als
Server-Env) und legt es neben die Aktivität in Postgres ab; der normale Pull
liefert es aus. Der Client spricht nie mit einem Kartendienst, die Karte ist
offline da, und eine abgeschlossene Aktivität ändert ihre Strecke ohnehin nie.
Fehlt das Bild (Dienst nicht erreichbar, Key fehlt), zeichnet die UI ersatzweise
die reine SVG-Spur aus den Koordinaten — der Kartendienst darf jederzeit
wegfallen, ohne dass etwas kaputtgeht.

## Alternativen, verworfen

- **Offizielle Health API** — Programm ausgesetzt, Firmenzulassung nötig.
- **Bibliothek mit Passwort-Login** (`garth`, `garminconnect` u. Ä.) — der
  blockierte Pfad; würde zudem ein Vollzugriff-Passwort in ein Secret legen,
  um dort eine 429 zu ernten.
- **`@flow-js/garmin-connect` als Dependency** — spart ~150 Zeilen eigenen
  Code, holt sich dafür 8 Fremdpakete und das kaputte Login-Stück mit ins
  Haus.
- **Playwright mit echtem Chrome, der die Web-App ausliest**
  (`garmin-data-bridge`-Muster) — funktioniert, braucht aber dauerhaft einen
  Browser plus `xvfb`; auf Vercel nicht lauffähig, für drei bis fünf Zahlen
  pro Aktivität unverhältnismäßig.
- **Aggregator-Dienst** (Terra, Rook, Spike) — kostenpflichtig, dritter
  Datenempfänger, Vendor-Lock-in.

## Konsequenzen

- Kein neues npm-Paket, keine ADR-Pflicht aus Regel 3 für eine Dependency —
  nur `fetch`-Code.
- Neuer, geschützter Pfad: Tokens (OAuth1 lang-, OAuth2 kurzlebig) liegen in
  Postgres (`src/db/`) und werden bei jedem Sync-Lauf aktualisiert — anders
  als bei Wetter (ADR-0009) gibt es hier serverseitig veränderlichen, nicht
  öffentlichen Zustand. Schema/Migration ist Teil des Bau-Tickets (T8b),
  nicht dieses ADR.
- GitHub-Actions-Cron statt Vercel-Cron ist ab hier die verbindliche Vorgabe
  für Hintergrundjobs dieser Art — vorherige Ticket-Texte, die „Vercel-Cron"
  nennen, sind ein Fehler im Ticket, nicht in der Architektur.
- Ein Kartendienst-API-Key kommt als weiteres Server-Env dazu; welcher Dienst
  konkret, entscheidet das Bau-Ticket.
- Folge-Tickets: T8b (Schema/Token-Store/Sync/Actions-Cron,
  geschützter Pfad `src/db/`) und T8c (Aktivitäten-Widget: Recap, Karte,
  Kurven).

## Risiken

Inoffiziell heißt: kann jederzeit brechen — genau das ist im März 2026 mit
dem Login-Weg passiert. Deshalb ist Garmin ein abgetrenntes Modul: Bricht es
weg, zeigt das Widget einen Leerzustand, und der Rest der App merkt nichts.
Der jährliche manuelle Bootstrap-Handgriff ist bewusst akzeptiert — jede
Alternative, die ihn vermeidet, ist teurer oder auf Vercel nicht lauffähig
(siehe „Alternativen, verworfen").
