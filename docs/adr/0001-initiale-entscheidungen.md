# ADR-0001: Initiale Grundsatzentscheidungen

Status: **angenommen** · Datum: 2026-07-13

Alle folgenden Entscheidungen sind getroffen. Sie werden nicht in jedem Ticket neu diskutiert.
Wer sie ändern will, schreibt ein neues ADR, das dieses ganz oder teilweise ablöst.

---

## 1. PWA statt nativer iOS-App

**Kontext:** Gewünscht war eine App, die dauerhaft auf dem iPhone bleibt — ohne wiederkehrende Gebühren.

**Entscheidung:** Progressive Web App, installiert über „Zum Home-Bildschirm".

**Begründung:**
- Der App Store setzt das Apple Developer Program (99 USD **pro Jahr**) voraus — genau die
  wiederkehrende Gebühr, die ausgeschlossen wurde.
- Der kostenlose Weg über eine Apple-ID in Xcode läuft nach 7 Tagen ab und ist unbrauchbar.
- Alternative Marktplätze in der EU (AltStore PAL) verlangen weiterhin die jährliche Notarisierungsgebühr.
- Home-Screen-Web-Apps funktionieren in der EU (Apple hatte die Entfernung 2024 angekündigt und
  nach Protesten zurückgenommen). Seit iOS 26 öffnen sie standardmäßig als Web-App.
- Web Push funktioniert für installierte PWAs seit iOS 16.4, inklusive Badge.

**Konsequenzen:**
- Kein Background Sync auf iOS — synchronisiert wird beim Öffnen/Fokussieren. Akzeptiert.
- iOS kann Cache bei sehr langer Nichtnutzung verwerfen. Unkritisch, weil der Server die Wahrheit hält.
- Kein App-Store-Eintrag. Irrelevant bei einem Nutzer.
- **Fluchtweg:** Dieselbe Codebasis lässt sich später mit Capacitor nativ verpacken,
  falls die 99 USD/Jahr doch akzeptabel werden. Die Architektur muss dafür nichts ändern.

---

## 2. Hosting: Vercel Hobby + Neon (kostenlos) statt eigenem Server

**Kontext:** Abwägung zwischen 0 € mit Einschränkungen und ~5 €/Monat VPS mit voller Kontrolle.

**Entscheidung:** kostenloser Free Tier.

**Begründung:** Die typischen Nachteile werden durch die Local-first-Architektur weitgehend
entschärft — eine kalte Datenbank ist unsichtbar, wenn die UI ohnehin aus IndexedDB liest.

**Konsequenzen (bewusst akzeptiert):**
- Cron auf dem Hobby-Plan ist zu selten → Hintergrundjobs laufen über **GitHub Actions Cron**.
- Keine langlaufenden Prozesse → Sync-Jobs müssen gestückelt und idempotent sein.
- Betreiber sind US-Unternehmen → **das Journal wird Ende-zu-Ende verschlüsselt** (siehe 4).
- Free Tiers können sich ändern → **Portabilitätsregel**: keine anbieterspezifischen Primitive,
  Umzug auf einen eigenen Server bleibt jederzeit möglich.

---

## 3. Local-first mit Outbox statt CRDT

**Kontext:** Die App muss offline funktionieren (Journal im Zug).

**Entscheidung:** IndexedDB (Dexie) als lokale Wahrheit, Mutations-Outbox, Last-Write-Wins
auf Feldebene über `updated_at`.

**Begründung:** Ein Nutzer, wenige Geräte. CRDTs oder ein Sync-Framework (ElectricSQL, Triplit)
lösen ein Problem, das hier nicht existiert, und bringen dafür Komplexität und Abhängigkeitsrisiko.

**Konsequenzen:**
- Jede synchronisierte Tabelle braucht `id` (UUIDv7), `updated_at`, `deleted_at`, `synced_at`.
- Harte Löschungen sind verboten (Tombstones), sonst „auferstehen" gelöschte Datensätze beim Sync.
- Echte Konflikte sind selten und werden protokolliert, nicht stillschweigend verworfen.

---

## 4. Journal Ende-zu-Ende-verschlüsselt

**Entscheidung:** Journal-Inhalte werden clientseitig mit AES-GCM (WebCrypto) verschlüsselt.
Der Server speichert nur Chiffrat.

**Begründung:** Der sensibelste Datenbestand liegt bei einem US-Anbieter. Weil die Suche
in einer Local-first-App ohnehin lokal läuft, kostet die Verschlüsselung praktisch nichts.

**Konsequenzen:**
- Keine serverseitige Suche über Journal-Inhalte. Bewusst akzeptiert.
- Passphrase verloren = Journal verloren. Recovery-Key wird beim Einrichten einmalig angezeigt.
- Metadaten (Datum, Stimmung, Tags) bleiben zunächst unverschlüsselt, damit Filter serverseitig gehen.

---

## 5. Kein Sync mit externen Kalendern

**Kontext:** Hauptkalender ist iCloud. Ein Zwei-Wege-Sync wäre nur über CalDAV möglich
(Apple bietet keine offizielle API) und wurde zunächst angedacht, dann verworfen.

**Entscheidung:** **Kein Kalender-Sync.** Die App führt ihren eigenen Kalender und ist
die alleinige Wahrheit für die Termine, die in ihr stehen.

**Begründung:**
- CalDAV-Zwei-Wege-Sync ist der mit Abstand komplexeste Teil des Projekts: Polling statt Push,
  Loop-Vermeidung über etag/ctag, Serientermin-Ausnahmen, Konfliktauflösung bei beidseitiger
  Änderung. Hoher Aufwand, hohe Fehleranfälligkeit, dauerhafte Wartungslast.
- Der Nutzen steht dazu in keinem Verhältnis, solange nicht klar ist, ob die App den
  bestehenden Kalender überhaupt ablöst.

**Konsequenzen:**
- Datenmodell wird deutlich einfacher: keine `calendar_links`, keine `external_uid`/`etag`.
- Kein Apple-Passwort auf dem Server → weniger Angriffsfläche.
- Serientermine bleiben nötig, aber nur in einfacher Form (täglich/wöchentlich/monatlich + Enddatum).
- **Ehrlicher Preis:** Termine, die weiter in iCloud landen (Einladungen per Mail, Siri, andere
  Personen), tauchen hier nicht auf. Es besteht das Risiko einer doppelten Buchführung.
  Dieses Risiko ist bewusst akzeptiert und wird nach ein paar Wochen Nutzung neu bewertet.
- Ein späterer **Einweg-Ausgang** (die App veröffentlicht einen abonnierbaren `.ics`-Feed,
  den Apple Kalender lesend einbindet) bleibt offen und wäre günstig zu bauen — siehe ADR-0002,
  falls das entschieden wird.

## 6. Ticketsystem: GitHub Issues

**Entscheidung:** GitHub Issues + Projects statt Linear/Jira.

**Begründung:** kostenlos, im selben Repo, per `gh`-CLI direkt für die KI nutzbar.
Ein zweites System bringt bei einem Ein-Personen-Projekt keinen Mehrwert.

---

## 7. Auth: Passkey

**Entscheidung:** WebAuthn/Passkey, kein Passwort-Login.

**Begründung:** Face ID auf dem iPhone, nichts zu merken, nichts zu leaken.
Bei einem einzigen Nutzer ist ein klassisches Passwortsystem reine Angriffsfläche ohne Nutzen.

**Konsequenzen:** Recovery-Code ist zwingend erforderlich und gehört in den Passwortmanager.
