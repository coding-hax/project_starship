import { expect, test, type Page } from '@playwright/test';
import { registerPasskey } from './helpers';

/**
 * Desktop-only (issue #1018, Teil 3 von #1015): `background-arcs.css` wechselt
 * von festen Pixeln auf vw/dvh, damit die Bögen auf 1280×800 einen Horizont
 * ergeben statt dreier kleiner Kuppeln in der Bildmitte. Läuft im Projekt
 * `desktop` (1280×800, `playwright.config.ts`); der 375×812-Rückfall unten
 * beweist, dass die vw/dvh-Formeln auf die heutigen, in `hintergrundboegen.spec.ts`
 * geprüften Pixelwerte zurückfallen.
 */

interface ArcMetrics {
  width: number;
  bottom: number;
  top: number;
}

async function arcMetrics(page: Page): Promise<ArcMetrics[]> {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll('.bg-layer .bg-arc')).map((el) => {
      const cs = getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return {
        width: parseFloat(cs.width),
        bottom: parseFloat(cs.bottom),
        top: rect.top,
      };
    }),
  );
}

test('AK (#1018): 1280×800 ergibt einen Horizont (Bogen breiter als der Viewport, Scheitel ~200px unter der Oberkante)', async ({
  page,
}) => {
  await registerPasskey(page);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/uebersicht');

  const [arc1] = await arcMetrics(page);
  const viewportWidth = page.viewportSize()!.width;
  expect(arc1.width, 'Bogen 1 (267vw) ist breiter als der 1280px-Viewport — Horizont, keine Kuppel').toBeGreaterThan(
    viewportWidth,
  );
  // 25,3dvh von 800px ≈ 202px, Toleranzband für Sub-Pixel-Rundung.
  expect(arc1.top, 'Scheitel von Bogen 1 liegt ~200px unter der Oberkante').toBeGreaterThanOrEqual(195);
  expect(arc1.top).toBeLessThanOrEqual(210);
});

const EXPECTED_MOBILE = [
  { width: 1000, bottom: -393 },
  { width: 790, bottom: -373 },
  { width: 570, bottom: -333 },
];

test('AK (#1018): 375×812-Rückfall bleibt bei den heutigen Pixelwerten (±2px = vw/dvh-Rundung, keine Aufweichung)', async ({
  page,
}) => {
  await registerPasskey(page);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto('/uebersicht');

  const arcs = await arcMetrics(page);
  expect(arcs).toHaveLength(3);
  for (const [i, expected] of EXPECTED_MOBILE.entries()) {
    expect(Math.abs(arcs[i].width - expected.width), `Bogen ${i + 1} Breite`).toBeLessThanOrEqual(2);
    expect(Math.abs(arcs[i].bottom - expected.bottom), `Bogen ${i + 1} bottom`).toBeLessThanOrEqual(2);
  }
});

// Puls-Hub je Bogen (bg-arc-pulse-1/2/3 in background-arcs.css), unverändert.
const HUBS = [1.05, 1.085, 1.12];

test('AK (#1018): Puls-Lift skaliert mit der gemessenen Bogenbreite, Desktop deutlich mehr als Mobil', async ({
  page,
}) => {
  await registerPasskey(page);
  await page.emulateMedia({ reducedMotion: 'reduce' });

  // Lift aus der gemessenen Breite berechnet (nicht durch Messen der laufenden
  // Animation — das wäre Flake, siehe AK3 des Tickets): scale:1.05 auf einen
  // 1000px-Bogen hebt ihn um 25px, derselbe Faktor auf 267vw ≈ 3418px um ~85px.
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto('/uebersicht');
  const mobileArcs = await arcMetrics(page);

  // Neu navigieren statt nur die Viewportgröße zu ändern: ein reiner Resize ohne
  // Navigation lässt vw/dvh in diesem Layout auf dem 375px-Stand einfrieren (siehe
  // Fortschrittskommentar #1018) — kein Playwright-Timing-Flake, sondern ein Rendering-
  // Zustand, den kein reales Nutzer-Szenario ohnehin durchläuft (ein Besuch bei 1280px
  // lädt die Seite frisch, wie Test 1 oben es tut).
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/uebersicht');
  const desktopArcs = await arcMetrics(page);

  expect(mobileArcs).toHaveLength(3);
  expect(desktopArcs).toHaveLength(3);

  for (const [i, hub] of HUBS.entries()) {
    const mobileLift = (mobileArcs[i].width * (hub - 1)) / 2;
    const desktopLift = (desktopArcs[i].width * (hub - 1)) / 2;
    expect(desktopLift, `Bogen ${i + 1}: Desktop-Lift > Mobil-Lift`).toBeGreaterThan(mobileLift);
  }

  // Bogen 1 (hub 1.05) explizit gegen die AK-Zahlen: ≈25px mobil, ≈85px desktop.
  const arc1MobileLift = (mobileArcs[0].width * (HUBS[0] - 1)) / 2;
  const arc1DesktopLift = (desktopArcs[0].width * (HUBS[0] - 1)) / 2;
  expect(Math.abs(arc1MobileLift - 25), 'Bogen 1 Lift mobil ≈25px').toBeLessThanOrEqual(3);
  expect(Math.abs(arc1DesktopLift - 85), 'Bogen 1 Lift desktop ≈85px').toBeLessThanOrEqual(3);
});
