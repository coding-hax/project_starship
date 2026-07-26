import { eq } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import { db } from '@/db';
import { garminTokens } from '@/db/schema';
import { exchangeOAuth1ForOAuth2, type OAuth1Credentials } from './connect-api';

/**
 * OAuth1 is expired or was never bootstrapped. The app is never allowed to try to
 * log in itself (ADR-0011, Punkt 3) — this is the signal that a human has to run
 * `scripts/garmin-bootstrap.md` again.
 */
export class GarminBootstrapRequired extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GarminBootstrapRequired';
  }
}

interface StoredOAuth2 {
  accessToken: string;
  refreshToken: string;
}

/** Refresh this much before actual expiry, so a slow request never straddles the boundary. */
const REFRESH_MARGIN_MS = 5 * 60 * 1000;

async function readToken(kind: 'oauth1' | 'oauth2') {
  const [row] = await db.select().from(garminTokens).where(eq(garminTokens.kind, kind)).limit(1);
  return row;
}

async function writeToken(
  kind: 'oauth1' | 'oauth2',
  token: unknown,
  expiresAt: Date | null,
): Promise<void> {
  await db
    .insert(garminTokens)
    .values({ id: uuidv7(), kind, token, expiresAt, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: garminTokens.kind,
      set: { token, expiresAt, updatedAt: new Date() },
    });
}

/**
 * A valid OAuth2 Bearer token, refreshing from OAuth1 when the stored one is
 * missing or close to expiry. The refreshed token is written back to Postgres
 * before this returns, so the next call — this run or the next — reuses it
 * instead of hitting Garmin again.
 *
 * Throws `GarminBootstrapRequired` when OAuth1 is missing or expired — never
 * retries, never attempts a login (ADR-0011).
 */
export async function ensureAccessToken(): Promise<string> {
  const oauth1Row = await readToken('oauth1');
  if (!oauth1Row) {
    throw new GarminBootstrapRequired(
      'Kein OAuth1-Token hinterlegt — siehe scripts/garmin-bootstrap.md.',
    );
  }
  if (oauth1Row.expiresAt && oauth1Row.expiresAt.getTime() <= Date.now()) {
    throw new GarminBootstrapRequired(
      'OAuth1-Token ist abgelaufen — siehe scripts/garmin-bootstrap.md.',
    );
  }

  const oauth2Row = await readToken('oauth2');
  if (
    oauth2Row &&
    oauth2Row.expiresAt &&
    oauth2Row.expiresAt.getTime() > Date.now() + REFRESH_MARGIN_MS
  ) {
    return (oauth2Row.token as StoredOAuth2).accessToken;
  }

  const oauth1 = oauth1Row.token as OAuth1Credentials;
  const fresh = await exchangeOAuth1ForOAuth2(oauth1);
  const expiresAt = new Date(Date.now() + fresh.expiresInSeconds * 1000);
  await writeToken(
    'oauth2',
    { accessToken: fresh.accessToken, refreshToken: fresh.refreshToken } satisfies StoredOAuth2,
    expiresAt,
  );

  return fresh.accessToken;
}
