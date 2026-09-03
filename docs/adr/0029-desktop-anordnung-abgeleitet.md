# ADR-0029: Desktop-Anordnung ist abgeleitet — geteilte Bauteile, freie Anordnung

Status: angenommen · Datum: 2026-09-02 · Bezug: #1016 (Epic #1015)

## Kontext

#564 nahm den Desktop-Viewport aus der CI; die Design-Doku verhärtete daraufhin
zu „Desktop ist dieselbe App, breiter — nie ein zweiter Entwurf" und
„Desktop-Layouts entstehen aus dem Hochformat, nicht umgekehrt", gelesen als
„Desktop bleibt einspaltig". #1015 hat entschieden, die Desktop-Fläche
(1280×800) zweispaltig neu anzuordnen. Ohne festgehaltene Doktrin baut die
nächste Design-Stufe den einspaltigen Stand wieder hin und hat schriftlich
recht. Dieses ADR hält nur fest, was #1015 ohnehin vorgibt.

## Entscheidung

1. **Geteilt bleibt alles außer der Anordnung.** Datenlogik (Dexie, Outbox,
   Sync, Live-Queries) und Bauteile (Komponenten, Hooks) sind für beide
   Breiten dieselben. Kein zweiter Komponentenbaum, keine Desktop-only-
   Features.
2. **Nur die Anordnung darf je Route abweichen** — ausschließlich über
   `@media (min-width: 768px)` in CSS, kein JS-Breakpoint-Switch, kein
   zweiter Render-Pfad.
3. **Vier Routen bekommen eine zweite Spalte:** Übersicht, Kalender,
   Aufgaben, Journal. Übersicht: Sektionen zweispaltig. Kalender:
   Monatsraster / Tagesliste. Aufgaben: fällige / „ohne Datum". Journal:
   Chronik in zwei Bahnen. Die verbindliche Anordnung steht je Route in
   #1020–#1023, nicht hier.
4. **Die Grenze:** Mobil (375×812) bleibt Entwurfsquelle und Maßstab.
   Desktop ist ein Re-Flow, kein Neuentwurf — keine Elemente, die mobil
   nicht existieren; keine andere Hierarchie; die mobile Reihenfolge bleibt
   lesbar erhalten.

## Alternativen, verworfen

- **Zweiter Komponentenbaum / Desktop-only-Screens.** Bricht „eine einzige,
  vorhersagbare App", verdoppelt Pflege und Test-Matrix.
- **Desktop bleibt einspaltig (Status quo).** Verschenkt die Fläche, #1015
  hat dagegen entschieden.
- **JS-gesteuerter Layout-Switch statt `@media`.** Hydration-/Flash-Risiko,
  zweiter Render-Pfad — eine CSS-Media-Query reicht.

## Konsequenzen

`docs/DESIGN_SYSTEM.md` (Leitsatz + harte Regel 3) und `docs/design/patterns.md`
(Abschnitt Desktop) verweisen ab jetzt hierher statt Zweispaltigkeit zu
verbieten. #1017 (CI-Projekt), #1018/#1019 (Bögen/Seitenleiste) und
#1020–#1023 (Routen) bauen gegen diese Doktrin. Kein Schema, kein Sync, keine
Krypto, keine Dependency, kein Laufzeitcode.
