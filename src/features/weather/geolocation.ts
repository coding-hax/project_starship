export type GeolocationFailureReason = 'denied' | 'unavailable' | 'timeout';

export class GeolocationRequestError extends Error {
  readonly reason: GeolocationFailureReason;

  constructor(reason: GeolocationFailureReason) {
    super(`Standortermittlung fehlgeschlagen: ${reason}`);
    this.reason = reason;
  }
}

export interface Coordinates {
  latitude: number;
  longitude: number;
}

const TIMEOUT_MS = 10_000;
// Position must not be older than one minute — the button is a one-off "jetzt", not
// a tracker, so a stale cached fix from a previous tab would be the wrong answer.
const MAXIMUM_AGE_MS = 60_000;

function reasonFor(error: GeolocationPositionError): GeolocationFailureReason {
  switch (error.code) {
    case error.PERMISSION_DENIED:
      return 'denied';
    case error.TIMEOUT:
      return 'timeout';
    default:
      return 'unavailable';
  }
}

/**
 * Thin Promise wrapper around `navigator.geolocation.getCurrentPosition` (issue
 * #853) — callers never see the callback API, only three namable failure reasons.
 */
export function getCurrentCoordinates(): Promise<Coordinates> {
  return new Promise((resolve, reject) => {
    if (!('geolocation' in navigator)) {
      reject(new GeolocationRequestError('unavailable'));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (position) => {
        resolve({ latitude: position.coords.latitude, longitude: position.coords.longitude });
      },
      (error) => {
        reject(new GeolocationRequestError(reasonFor(error)));
      },
      { enableHighAccuracy: false, timeout: TIMEOUT_MS, maximumAge: MAXIMUM_AGE_MS },
    );
  });
}
