# ADR-0030: Desktop dritte Stufe ab 1440px — alle Routen, Seitenkopf einzeilig

Status: angenommen · Datum: 2026-09-08 · Bezug: #1114 (Teil von Epic #1113) ·
löst ADR-0029 ab

## Kontext

ADR-0029 hat für #1015 die erste Desktop-Stufe festgehalten: ab 768px bis zu
einer zweiten Spalte, begrenzt auf vier benannte Routen (Übersicht, Kalender,
Aufgaben, Journal). #1113 baut die Fläche für breitere Desktop-Viewports
(≥1440px) weiter aus. Ohne aktualisierte Doktrin bauen die Folge-Tickets aus
#1113 gegen die eigene Doku, die noch bei „bis zu einer zweiten Spalte" und
vier benannten Routen steht.

## Entscheidung

1. **Drei Stufen statt zwei:** ≤ 767px mobil (Entwurfsquelle, einspaltig),
   768–1439px zwei Spalten (wie ADR-0029), ab 1440px eine dritte Stufe mit
   bis zu **drei Spalten**.
2. **Alle Routen statt vier benannter.** Die dritte Spalte ist kein auf vier
   Routen begrenztes Kontingent — jede Route darf ab 1440px eine dritte
   Spalte bekommen, wenn ihr Inhalt das hergibt. Weiterhin gilt: nur die
   Anordnung weicht ab, Bauteile und Datenlogik bleiben geteilt (ADR-0029,
   Punkt 1 + 2 bleiben in Kraft).
3. **Seitenkopf wird ab der dritten Stufe eine Zeile.** Der bislang
   gestapelte Drei-Zonen-Kopf (Beiwerk/Augenbraue oben, Titelzeile, Zusatz)
   rückt ab 1440px in eine Zeile zusammen: Beiwerk links, Titel und Figur
   rechts.
4. **Die Grenze bleibt:** Mobil (375×812) bleibt Entwurfsquelle und Maßstab.
   Auch die dritte Stufe ist ein Re-Flow, kein Neuentwurf — keine Elemente,
   die mobil nicht existieren; keine andere Hierarchie.

## Alternativen, verworfen

- **Vierte Spalte oder mehr.** Übersteigt, was bei 1440px CSS-px an Inhalt
  sinnvoll nebeneinander passt; bricht harte Regel 1 („Hauptinhalt in einer
  Bildschirmhöhe erfassbar").
- **Dritte Spalte weiterhin auf benannte Routen begrenzen.** Verlangt bei
  jeder neuen Route erneut eine Grundsatzentscheidung; die Begrenzung war
  nur nötig, um die erste (768px-)Stufe klein zu halten — bei 1440px ist die
  Fläche für jede Route vorhanden.
- **Seitenkopf gestapelt lassen.** Verschenkt bei 1440px vorhandene Breite;
  eine Zeile fasst Beiwerk, Titel und Figur ohne zusätzliche Bildschirmhöhe
  zu kosten (harte Regel 1).

## Konsequenzen

`docs/DESIGN_SYSTEM.md` (Leitsatz + harte Regel 3) und `docs/design/patterns.md`
(Abschnitt Desktop) verweisen ab jetzt zusätzlich hierher. ADR-0029 gilt als
durch dieses ADR abgelöst, bleibt aber als Beleg der ersten (768px-)Stufe
stehen — nicht gelöscht. Kein Schema, kein Sync, keine Krypto, keine
Dependency, kein Laufzeitcode — die Umsetzung in CSS/Komponenten folgt in
eigenen Tickets aus #1113.
