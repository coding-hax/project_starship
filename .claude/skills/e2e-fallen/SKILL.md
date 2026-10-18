---
name: e2e-fallen
description: Bekannte Playwright-Fallen dieses Repos und die Helfer, die sie lösen. Laden, bevor du einen e2e-Spec (tests/*.spec.ts) schreibst oder erweiterst, und bevor du einen roten e2e-Lauf deutest.
---

# e2e-Fallen

Jede Falle hier hat mindestens eine rote CI-Runde gekostet. Halte die Liste gegen
deinen Spec, bevor du ihn pushst. Helfer stehen als `tests/<datei>: <name>` da —
`scripts/tests/claude-hooks.test.sh` prüft, dass es sie dort gibt. Wer einen
umbenennt, zieht diese Datei mit.

**Was CI ohnehin verbietet** (`check-test-integrity.sh`, meldet sich auch schon
beim Editieren): `.only`, `.skip`, `xit`, `test.fixme`, `waitForTimeout`,
`new Date()` ohne Argument. Uhr über `tests/helpers.ts: installClockAt` mit
`tests/helpers.ts: FIXED_NOW`. Die Testanzahl darf nicht sinken.

**Viewports** (`playwright.config.ts`): `mobile` 375 × 812 für alle übrigen
Specs, `*.desktop.spec.ts` 1280 × 800, `*.wide.spec.ts` 1800 × 1000. Jeder Spec
läuft in genau einem Projekt.

## Sichtbarkeit und Locator

1. **CSS blendet aus, der Knoten bleibt.** Mobile-, Desktop- und Wide-Variante
   stehen oft gleichzeitig im DOM (`display: none`, CSS `order`). `count()` und
   ein seitenweites `getByText` zählen die versteckte mit — strict-mode-Fehler
   oder falsche Zahl. Sichtbarkeit mit `toBeVisible()`/`not.toBeVisible()`
   prüfen, den Locator auf den Container scopen, `getByRole` nehmen (filtert
   Verstecktes heraus). Beispiel: `.app-header__settings` gibt es zweimal, also
   `getByRole('link', { name: 'Einstellungen' })`.
2. **Gegenrichtung SVG.** Eine achsenparallele `<line>` hat eine BBox der Breite
   oder Höhe 0, `toBeVisible()` meldet sie `hidden`. Dort `count()` oder
   Attribute prüfen (Vorbild `git show ca6d4a3:tests/wetter.wide.spec.ts`).

## Zeit

3. CI läuft in UTC. Lokal deshalb `TZ=UTC pnpm exec playwright test …` — sonst
   lesen `datetime-local`-Felder in Europe/Berlin, und jede Erwartung liegt
   exakt um den Offset daneben.
4. Keine Testzeit auf die Minute von `FIXED_NOW` (12:00 UTC = 14:00 in Berlin)
   legen: Vergleiche wie `candidate > now` kippen dann je nach Zeitzone.
5. `tests/helpers.ts: skewClock` setzt nur die Uhr und rendert nichts neu.
   Danach einmal `page.goto`/`page.reload`, erst dann seeden (Vorbild
   `tests/habits-uebersicht.spec.ts`).

## Netz und Seiteneffekte

6. `tests/helpers.ts: registerPasskey` landet auf `/uebersicht`, und die Seite
   fragt open-meteo ab. Jeder Spec, der `/uebersicht` erreicht, mockt
   `https://api.open-meteo.com/**` mit `tests/helpers.ts: openMeteoForecastBody`
   (Vorbild `tests/weather-location.spec.ts`). Ungemockt hängt `networkidle`, oder ein
   Konsolen-Assert wird rot.
7. `networkidle` meiden: eine zweite Navigation bricht RSC-Prefetches ab, und
   abgebrochene Requests verlassen Playwrights Zählung nie (Laufzeit dann
   zweigipflig, 2 s oder 31 s). Auf ein konkretes Element oder eine Antwort warten.
8. `tests/helpers.ts: openSecondDevice` navigiert selbst nach `/uebersicht`,
   bevor du dort Routen blockst. Der erste Pull läuft also echt, und
   `JournalHabitBoot` legt die Routine „Journal" an. Zählt der Test nur Aufgaben:
   `tests/modules.spec.ts: setModulesOff` mit `['routinen']`.
9. `tests/helpers.ts: settleJournalHabitBoot` nie in einem `describe`, dessen
   `beforeEach` `**/api/sync/**` abbricht — der Boot ist dort ohnehin still, der
   Helfer läuft in den Timeout.
10. Service Worker: nach `navigator.serviceWorker.ready` auf
    `controller !== null` pollen, **nicht** neu laden — `reload` wirft Nexts
    Router-Cache weg, von dem jeder Offline-Gang lebt.
11. Angekommener RSC-Prefetch: über `page.on('response')` mit `status() < 400`
    zählen, nicht über `requestfinished` — Next bricht den Request nach dem
    Lesen ab.

## Farben und Geometrie

12. `getComputedStyle` liefert `oklch(…)` bzw. `color-mix(…)`, kein `rgb(…)`.
    Über Canvas umrechnen: `cssColorToRgb` in
    `git show ca6d4a3:tests/seitenleiste-grund.desktop.spec.ts`.
    Ein Regex-Parser liest `oklch(0.18 …)` als `18,0,0`.
13. `boundingBox()` enthält Transforms. Erst messen, wenn `el.getAnimations()`
    nichts Laufendes mehr meldet — sonst misst du die Enter-Animation als
    Layout-Shift.
14. `offsetTop` zählt ab dem nächsten positionierten Vorfahren. In Scroll-Spuren
    gegen `track.getBoundingClientRect().top - track.scrollTop` messen.
15. `align-items: baseline` verschiebt bei gemischten Schriften um 1 px —
    `flex-start` nehmen. `grid-row: 2 / -1` ohne `grid-template-rows` springt in
    die falsche Zeile; `span` nehmen, Überhöhe per
    `grid-template-rows: auto auto 1fr` in die letzte Zeile lenken.
16. `env(safe-area-inset-top)` ist im Testbrowser 0. Ein Test gegen die
    Notch-Zone braucht einen überschreibbaren Anker, sonst ist er grün ohne Aussage.
17. React 19 flusht Klicks im Microtask: wer im selben `page.evaluate` direkt
    nach `click()` liest, sieht das alte DOM. Erst einen `requestAnimationFrame`
    abwarten (Vorbild `tests/kalender.spec.ts: agendaAfterDaySwitch`).
18. `page.addInitScript` läuft, bevor `document.head` existiert — ein
    `appendChild` dort verpufft. `addStyleTag` überlebt dafür kein `page.goto`.

## Eingaben und Zählwerte

19. Erfassungs-Specs setzen ihren Text meist über Helfer, nicht über `fill()`:
    `tests/capture.spec.ts: submitQuickAdd`,
    `tests/capture-art.spec.ts: submitCapture`,
    `tests/capture-uebersicht.spec.ts: submitUebersichtCapture`. Wer Eingaben
    gegen den Parser nachrechnet, greppt alle Wege.
20. Layout-Specs schreiben Routenzahlen aus („alle neun Routen", `toBe(9)`).
    Wer eine Route entfernt, greppt nach Zahlwörtern und `toHaveCount(`.

## Lokal prüfen, Rot deuten

21. Tests über `--grep "<Name>"` auswählen, nicht über `datei:zeile` — die Zeile
    verrutscht ohne Fehlermeldung. Die Zahl der gelaufenen Tests nachzählen.
22. Ein Spec je `test-runner`-Auftrag, dazwischen committen und pushen.
    Gebündelte Specs sprengen das 45-Minuten-Fenster.
23. „Nur eine Shard rot" belegt keinen Flake: Playwright shardet nach Tests,
    der Test lief nur dort. Rot in CI und grün lokal heißt zuerst Linux gegen
    macOS (Schriftmetriken), nicht „selten".
24. Kein `src/`-Diff, aber e2e rot: nicht deine Regression. Steht der PR auf
    `BEHIND`, zuerst `gh pr update-branch`.
25. Lokale e2e gegen eine eigene Datenbank: eigene `.env.local` im Worktree statt
    des Symlinks, `SLOT_ID` verschiebt den Port. Die geteilte DB gehört allen Slots.
