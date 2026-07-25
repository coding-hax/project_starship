// Zeitquelle, injizierbar -- Vitest haengt so nie an der echten Uhrzeit (#198).

export interface Clock {
  now(): Date;
}

export function createClock(): Clock {
  return { now: () => new Date() };
}

export function createFixedClock(instant: Date): Clock {
  return { now: () => instant };
}
