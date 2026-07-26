import { createHmac, randomBytes } from 'node:crypto';

/**
 * Unofficial `connectapi.garmin.com` access, tokenbased (ADR-0011). No client
 * library — a hand-rolled OAuth1 signature plus a handful of `Authorization:
 * Bearer …` GETs is the whole surface, and it is small enough that a dependency
 * would only buy a broken login flow along with it (see the ADR's "Alternativen,
 * verworfen").
 */

export interface OAuth1Credentials {
  token: string;
  tokenSecret: string;
}

export interface OAuth2Token {
  accessToken: string;
  refreshToken: string;
  /** Seconds until expiry, as returned by Garmin — the caller turns this into a timestamp. */
  expiresInSeconds: number;
}

/**
 * Garmin's OAuth1 consumer key/secret are not a secret an individual account
 * holds — every Garmin Connect client (including the official app) is built with
 * the same pair, published by the `garth` project so the reverse-engineered
 * clients that came after it did not each have to extract it from an APK. Fetched
 * once per process, not hardcoded, so a rotation does not need a code change.
 */
const OAUTH_CONSUMER_URL = 'https://thegarth.s3.amazonaws.com/oauth_consumer.json';

interface OAuthConsumer {
  consumerKey: string;
  consumerSecret: string;
}

let cachedConsumer: OAuthConsumer | null = null;

async function getOAuthConsumer(): Promise<OAuthConsumer> {
  if (cachedConsumer) return cachedConsumer;

  const response = await fetch(OAUTH_CONSUMER_URL);
  if (!response.ok) {
    throw new Error(`OAuth-Consumer-Abruf antwortete mit Status ${response.status}`);
  }
  const body = (await response.json()) as { consumer_key: string; consumer_secret: string };
  cachedConsumer = { consumerKey: body.consumer_key, consumerSecret: body.consumer_secret };
  return cachedConsumer;
}

function percentEncode(value: string): string {
  return encodeURIComponent(value).replace(/[!*'()]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

/** RFC 5849 signature base string + HMAC-SHA1 — the one piece of the protocol with no shortcut. */
function signOAuth1(
  method: string,
  url: string,
  params: Record<string, string>,
  consumerSecret: string,
  tokenSecret: string,
): string {
  const sortedKeys = Object.keys(params).sort();
  const paramString = sortedKeys
    .map((key) => `${percentEncode(key)}=${percentEncode(params[key])}`)
    .join('&');
  const baseString = [method.toUpperCase(), percentEncode(url), percentEncode(paramString)].join('&');
  const signingKey = `${percentEncode(consumerSecret)}&${percentEncode(tokenSecret)}`;
  return createHmac('sha1', signingKey).update(baseString).digest('base64');
}

function buildOAuth1Header(
  method: string,
  url: string,
  consumerKey: string,
  consumerSecret: string,
  oauth1: OAuth1Credentials,
): string {
  const params: Record<string, string> = {
    oauth_consumer_key: consumerKey,
    oauth_token: oauth1.token,
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: Math.floor(Date.now() / 1000).toString(),
    oauth_nonce: randomBytes(16).toString('hex'),
    oauth_version: '1.0',
  };
  const signature = signOAuth1(method, url, params, consumerSecret, oauth1.tokenSecret);

  const headerParams: Record<string, string> = { ...params, oauth_signature: signature };
  const header = Object.keys(headerParams)
    .sort()
    .map((key) => `${percentEncode(key)}="${percentEncode(headerParams[key])}"`)
    .join(', ');
  return `OAuth ${header}`;
}

/**
 * Trades the long-lived OAuth1 pair for a fresh ~1h OAuth2 access token. Called by
 * `tokens.ts` whenever the stored OAuth2 token is missing or expired — never
 * cached here, that is the caller's job (it also has to persist the result).
 */
export async function exchangeOAuth1ForOAuth2(oauth1: OAuth1Credentials): Promise<OAuth2Token> {
  const url = 'https://connectapi.garmin.com/oauth-service/oauth/exchange/user/2.0';
  const { consumerKey, consumerSecret } = await getOAuthConsumer();
  const authorization = buildOAuth1Header('POST', url, consumerKey, consumerSecret, oauth1);

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: authorization,
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': 'com.garmin.android.apps.connectmobile',
    },
  });

  if (!response.ok) {
    throw new Error(`OAuth2-Tausch antwortete mit Status ${response.status}`);
  }

  const body = (await response.json()) as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
  };

  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token,
    expiresInSeconds: body.expires_in,
  };
}

export interface GarminActivityListEntry {
  activityId: number;
  activityName: string | null;
  activityType: { typeKey: string };
  startTimeLocal: string;
  distance: number | null;
  duration: number | null;
  movingDuration: number | null;
  elapsedDuration: number | null;
  elevationGain: number | null;
  elevationLoss: number | null;
  averageHR: number | null;
  maxHR: number | null;
  averageSpeed: number | null;
  calories: number | null;
}

function connectApiHeaders(accessToken: string): HeadersInit {
  return { Authorization: `Bearer ${accessToken}` };
}

/** Header numbers for every activity in `[start, start + limit)` of the window. */
export async function fetchActivityList(
  accessToken: string,
  options: { start: number; limit: number; startDate: string; endDate: string },
): Promise<GarminActivityListEntry[]> {
  const url =
    `https://connectapi.garmin.com/activitylist-service/activities/search/activities` +
    `?start=${options.start}&limit=${options.limit}&startDate=${options.startDate}&endDate=${options.endDate}`;

  const response = await fetch(url, { headers: connectApiHeaders(accessToken) });
  if (!response.ok) {
    throw new Error(`Aktivitätsliste antwortete mit Status ${response.status}`);
  }
  return (await response.json()) as GarminActivityListEntry[];
}

export interface GarminActivityDetailsResponse {
  metricDescriptors: { metricsIndex: number; key: string }[];
  activityDetailMetrics: { metrics: (number | null)[] }[];
}

/** Map, HF-, Pace- and Höhenkurve for one activity, all in a single call. */
export async function fetchActivityDetails(
  accessToken: string,
  garminActivityId: number,
): Promise<GarminActivityDetailsResponse> {
  const url =
    `https://connectapi.garmin.com/activity-service/activity/${garminActivityId}/details` +
    `?maxChartSize=500&maxPolylineSize=500`;

  const response = await fetch(url, { headers: connectApiHeaders(accessToken) });
  if (!response.ok) {
    throw new Error(`Aktivitätsdetails antworteten mit Status ${response.status}`);
  }
  return (await response.json()) as GarminActivityDetailsResponse;
}
