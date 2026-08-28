import { berlinNow } from '@/push/schedule';

export type Greeting = 'Guten Morgen' | 'Guten Mittag' | 'Guten Abend' | 'Gute Nacht';

/**
 * Vier Stufen nach Ortszeit (issue #862, AK1) — "Ortszeit" heißt hier wie überall
 * sonst im Projekt (push/schedule.ts, event-time.ts) Europe/Berlin, nicht die
 * Zeitzone des Geräts, auf dem gerade Node/der Browser läuft: sonst zeigt dieselbe
 * Sekunde je nach Host-TZ (CI in UTC, ein Entwickler-Mac in Europe/Berlin) eine
 * andere Stufe. Grenzen als Minuten seit Mitternacht, damit 22:00–05:00
 * (Mitternacht-Wrap) ohne Sonderfall bleibt: alles außerhalb der drei
 * Tages-Fenster ist Nacht.
 */
export function greetingFor(date: Date): Greeting {
  const { minutesOfDay } = berlinNow(date);

  if (minutesOfDay >= 5 * 60 && minutesOfDay < 11 * 60) return 'Guten Morgen';
  if (minutesOfDay >= 11 * 60 && minutesOfDay < 17 * 60) return 'Guten Mittag';
  if (minutesOfDay >= 17 * 60 && minutesOfDay < 22 * 60) return 'Guten Abend';
  return 'Gute Nacht';
}
