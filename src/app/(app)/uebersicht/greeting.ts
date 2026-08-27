export type Greeting = 'Guten Morgen' | 'Guten Mittag' | 'Guten Abend' | 'Gute Nacht';

/**
 * Vier Stufen nach Ortszeit (issue #862, AK1) — Grenzen als Minuten seit
 * Mitternacht, damit 22:00–05:00 (Mitternacht-Wrap) ohne Sonderfall bleibt: alles
 * außerhalb der drei Tages-Fenster ist Nacht.
 */
export function greetingFor(date: Date): Greeting {
  const minuteOfDay = date.getHours() * 60 + date.getMinutes();

  if (minuteOfDay >= 5 * 60 && minuteOfDay < 11 * 60) return 'Guten Morgen';
  if (minuteOfDay >= 11 * 60 && minuteOfDay < 17 * 60) return 'Guten Mittag';
  if (minuteOfDay >= 17 * 60 && minuteOfDay < 22 * 60) return 'Guten Abend';
  return 'Gute Nacht';
}
