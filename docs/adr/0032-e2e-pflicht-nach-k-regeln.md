# ADR-0032: E2E-Pflicht nach K-Regeln, Optik prüft der Mensch

Status: angenommen · Datum: 2026-10-19 · Bezug: #1215, #1210 · Nachtrag zu
[ADR-0026](0026-ak-check-als-merge-tor.md) §3

## Kontext

#1210 hat die Playwright-Suite von 1.579 auf 235 Tests geschnitten, nach
Kriterien, welcher Test etwas absichert, das beim Benutzen der App nicht
sofort sichtbar ist oder zu spät auffällt (Datenverlust, Leck, unbenutzbarer
Kernablauf, Absturz). Diese Kriterien galten dort nur rückwirkend, für die
damals bestehenden 1.579 Tests.

Drei Stellen erzwingen heute trotzdem weiter einen Playwright-Test **je
Akzeptanzkriterium**, unabhängig davon, ob das Kriterium rein optisch ist:
`CLAUDE.md` („Tests sind der Auftrag", Definition of Done), `docs/workflow/
ticket-und-tests.md` und der AK-Prüfer-Prompt (`scripts/runner/prompts.ts`,
ADR-0026 §3: `erfüllt` verlangt Code **und** Test, ein unbelegtes optisches
Kriterium gilt als „nicht prüfbar" und geht zurück in den Bau). Bei rund zehn
neuen E2E-Tests je Ticket ist die Suite in wenigen Wochen wieder dort, wo
#1210 angefangen hat.

Owner-Entscheidung (Chat, 18.10.2026): die Kriterien aus #1210 werden für
künftige Tickets bindend. Das ändert ADR-0026 §3 — das ist beschlossen, nicht
neu zu verhandeln.

## Entscheidung

Ein E2E-Test ist nur noch Pflicht für Akzeptanzkriterien, die unter **K1–K5**
fallen. Kriterien unter **D1–D7** verlangen keinen E2E-Test — sie prüft der
Mensch am Gerät.

**K-Regeln (Test bleibt Pflicht), Kurzfassung — Vollfassung in #1210:**

- **K1 Datenintegrität** — Verlust, Verfälschung, Verdopplung, Wiederauferstehen
  von Daten: Sync, Offline-Rundreise, Tombstones, Konfliktauflösung, Migration,
  DB-Constraints, Export.
- **K2 Sicherheit & Privatsphäre** — Anmeldung, Sitzungen, Passkeys, Recovery,
  401/403, Kontentrennung, Journal-Verschlüsselung.
- **K3 Kernablauf** — eine Kernhandlung, ohne die ein Bereich unbenutzbar ist.
- **K4 Browser-Mechanik** — gibt es nur im echten Browser: Service Worker,
  IndexedDB über Reloads, Timer, Hydration.
- **K5 Stille Regression** — für einen echten Fund geschrieben, dessen Symptom
  still oder schwer war.

**D-Regeln (kein E2E-Test), Kurzfassung:**

- **D1 Optik-Pin** — Farben, Kontrast, Radien, Abstände, Größen, Animationen.
- **D2 Varianten-Kopie** — dasselbe Verhalten nochmal in Dark Mode,
  reduced-motion, anderem Viewport.
- **D3 Abwesenheit von Entferntem**, **D4 Dublette**, **D5 weitere
  Offline-Kopie eines schon abgedeckten Schreibwegs**, **D6
  Implementierungsdetail**, **D7 Bedien-Feinschliff**.

**Mechanik:** ein Ticket-Autor markiert ein Kriterium, das unter D1–D7 fällt,
mit dem Klammer-Zusatz `(prüft der Mensch am Gerät)` am Ende der
Kriteriumszeile. Der AK-Prüfer wertet ein so markiertes Kriterium mit
Code-Beleg **ohne** Test als erfüllt (ADR-0026 §3, Nachtrag #1215).

**Offline-Rundreise bleibt Pflicht, aber nur je neuem Schreibweg.** Eine neue
synchronisierte Tabelle oder eine neue Mutation braucht einen Offline-Test
(K1); eine weitere Offline-Kopie eines schon abgedeckten Schreibwegs fällt
unter D5.

Der Marker-String ist bewusst Text im Kriterium, kein strukturiertes Feld:
`scripts/runner/ak.ts` normalisiert beim Parsen nur Whitespace und hängt
Folgezeilen an (Zeile 85) — der Zusatz überlebt das unverändert, es braucht
keine Parser-Änderung. Checker und Planer sind LLM-Läufe und lesen den Zusatz
im Kriteriumstext.

## Konsequenzen

Die Suite wächst nach neuen Tickets nicht mehr automatisch nach — ein Ticket
mit zehn Akzeptanzkriterien, von denen acht D-Regeln sind, bekommt zwei neue
Tests statt zehn. Das ist genau die Verschiebung, die #1210 für die
Bestandssuite vorgenommen hat, jetzt als Dauerregel für neue Tickets.

Ein markiertes Kriterium ohne jeden Code-Beleg bleibt weiterhin „nicht
prüfbar" — der Marker befreit vom Test, nicht vom Beleg.

## Verworfene Alternativen

- **Weiter 1:1 ein E2E-Test je Akzeptanzkriterium.** Verworfen: die Suite
  wüchse zurück auf die Größenordnung von vor #1210 (1.579 Tests, 125 min
  Testzeit).
- **Ein zweites, strukturiertes Feld statt eines Text-Markers** (z. B. ein
  YAML-Frontmatter-Attribut je Kriterium). Verworfen: `ak.ts` müsste dafür
  umgebaut werden, und Ticket-Autoren tippen das Issue-Formular ohnehin als
  Freitext — ein Klammer-Zusatz ist für sie die niedrigere Hürde.
