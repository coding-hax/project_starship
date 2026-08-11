import { promises as dns } from 'node:dns';
import { NextResponse } from 'next/server';
import { requireOwner, UnauthorizedError } from '@/auth/session';
import { assertPublicHttpsUrl, isBlockedAddress, SsrfBlockedError } from './ssrf';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs'; // dns.promises.lookup needs the Node runtime, not Edge

const FETCH_TIMEOUT_MS = 10_000;
const MAX_BODY_BYTES = 5 * 1024 * 1024; // 5 MB — an .ics feed has no legitimate reason to exceed this
const MAX_REDIRECTS = 5;

/**
 * Resolves `url`'s host and rejects if any returned address is
 * loopback/private/link-local/metadata (ADR-0022). Rejecting on *any* blocked
 * address (not just the first) closes the gap where a DNS answer mixes a
 * public and a private address to slip past a first-match check.
 */
async function assertResolvesToPublicAddress(url: URL): Promise<void> {
  let addresses: { address: string }[];
  try {
    addresses = await dns.lookup(url.hostname, { all: true });
  } catch {
    throw new SsrfBlockedError('Adresse konnte nicht aufgelöst werden.');
  }
  if (addresses.length === 0 || addresses.some((entry) => isBlockedAddress(entry.address))) {
    throw new SsrfBlockedError('Zieladresse ist nicht öffentlich erreichbar.');
  }
}

/** Full validation (schema + DNS + IP-Sperre) — run once per hop, never trusted from a previous hop. */
async function validateHop(raw: string): Promise<URL> {
  const url = assertPublicHttpsUrl(raw);
  await assertResolvesToPublicAddress(url);
  return url;
}

/**
 * Streams `response.body` up to `MAX_BODY_BYTES`, aborting the underlying
 * connection instead of buffering an unbounded/endless feed into memory.
 */
async function readCappedText(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return '';

  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BODY_BYTES) {
      await reader.cancel();
      throw new Error('body too large');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString('utf-8');
}

/**
 * SSRF-abgesicherter Proxy für externe `.ics`-Feeds (issue #560, ADR-0022):
 * die einzige Route, die eine vom Nutzer eingetragene URL serverseitig abruft.
 * `src/local/ics-fetch.ts` ist der einzige Client-seitige Aufrufer
 * (check-sync-invariants.sh).
 */
export async function GET(request: Request) {
  try {
    await requireOwner();
  } catch (error) {
    if (error instanceof UnauthorizedError) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    throw error;
  }

  const raw = new URL(request.url).searchParams.get('url');
  if (!raw) {
    return NextResponse.json({ error: 'url fehlt.' }, { status: 400 });
  }

  let currentUrl: URL;
  try {
    currentUrl = await validateHop(raw);
  } catch (error) {
    if (error instanceof SsrfBlockedError) {
      const status = error.message.includes('https') || error.message.includes('Ungültige') ? 400 : 403;
      return NextResponse.json({ error: error.message }, { status });
    }
    throw error;
  }

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    let response: Response;
    try {
      response = await fetch(currentUrl, {
        redirect: 'manual',
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
    } catch {
      return NextResponse.json({ error: 'Quelle nicht erreichbar.' }, { status: 502 });
    }

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location) {
        return NextResponse.json({ error: 'Weiterleitung ohne Ziel.' }, { status: 502 });
      }
      if (hop === MAX_REDIRECTS) {
        return NextResponse.json({ error: 'Zu viele Weiterleitungen.' }, { status: 502 });
      }
      let nextUrl: URL;
      try {
        nextUrl = await validateHop(new URL(location, currentUrl).toString());
      } catch (error) {
        if (error instanceof SsrfBlockedError) {
          return NextResponse.json({ error: error.message }, { status: 403 });
        }
        throw error;
      }
      currentUrl = nextUrl;
      continue;
    }

    if (!response.ok) {
      return NextResponse.json({ error: `Quelle antwortete mit Status ${response.status}` }, { status: 502 });
    }

    let text: string;
    try {
      text = await readCappedText(response);
    } catch {
      return NextResponse.json({ error: 'Feed ist zu groß.' }, { status: 502 });
    }

    return new NextResponse(text, { status: 200, headers: { 'content-type': 'text/calendar' } });
  }

  return NextResponse.json({ error: 'Zu viele Weiterleitungen.' }, { status: 502 });
}
