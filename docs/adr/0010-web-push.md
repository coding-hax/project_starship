# ADR-0010: `web-push` für VAPID-Signierung und Payload-Verschlüsselung

Status: **angenommen** · Datum: 2026-07-26

## Kontext

Issue #122 liefert das Push-Grundgerüst: ein Gerät legt ein Abo an, der Server
verschickt darüber eine Nachricht. Ein Versand braucht zwei kryptografische
Bausteine:

1. **VAPID-JWT** (RFC 8292) — ein mit dem privaten Schlüssel des Servers
   signierter Token (ES256), der den Push-Dienst des Browsers autorisiert.
2. **Payload-Verschlüsselung** (RFC 8291) — ECDH über P-256, HKDF, AES-128-GCM,
   damit der Push-Dienst (Google/Mozilla/Apple) den Nachrichteninhalt nicht
   lesen kann.

CLAUDE.md Regel 3 verlangt für jede neue Dependency ein ADR.

## Entscheidung

**`web-push` (npm) wird angenommen**, sowohl für den Versand als auch für die
VAPID-Schlüsselerzeugung (einmalig durch den Menschen, `npx web-push
generate-vapid-keys`).

## Begründung

RFC 8291 von Hand zu implementieren ist dieselbe Aufwand-real-Risiko-still-
Klasse, die ADR-0003 §1 (SimpleWebAuthn) gegen eigenen WebAuthn-Code
entschied: ein Fehler in der Payload-Verschlüsselung zeigt sich nicht als
Absturz, sondern als Nachricht, die beim Empfänger nie ankommt oder sich nicht
entschlüsseln lässt — schwer zu testen, schwer zu debuggen. `web-push` ist der
De-facto-Standard im Node-Ökosystem, deckt beide RFCs vollständig ab und ist
vendor-neutral: er spricht gegen den vom Browser gewählten `endpoint`
(`https://fcm.googleapis.com/...`, `https://updates.push.services.mozilla.com/...`
etc.), nicht gegen einen fest verdrahteten Dienst. Kein Vercel- oder
Neon-Bezug, keine Verletzung von Regel 7.

## Alternative (verworfen)

VAPID selbst per WebCrypto (ES256-Signatur ist damit machbar) plus
**payload-lose „Tickle"-Pushes**: der Push enthält keinen verschlüsselten
Inhalt, der Service Worker holt die eigentliche Nachricht danach per Fetch
gegen die eigene API. Das vermeidet RFC 8291 komplett, ist aber
offline-fragiler (der Tickle allein reicht nicht, ein zweiter Roundtrip muss
gelingen) und liefert keinen Klartext-Body für die einfache Testnachricht
(AC1). Nicht empfohlen, aber technisch tragfähig, falls diese Dependency
abgelehnt wird.

## Konsequenzen

- Neue Laufzeit-Abhängigkeit: `web-push` (+ Dev-Typen `@types/web-push`).
- `VAPID_PRIVATE_KEY` ist ein Secret (Regel 10): nur Server-Env, nie
  `NEXT_PUBLIC_*`, nie im Repo, nie geloggt. `NEXT_PUBLIC_VAPID_PUBLIC_KEY`
  ist öffentlich (steckt im Client-`applicationServerKey`).
- Versand läuft node-only (`web-push` ist CommonJS) — bewusst hinter einer
  portablen Funktion (`src/push/send.ts`), damit ein späterer Umzug von
  Vercel auf einen eigenen Server (oder ein GitHub-Actions-Cron statt eines
  manuellen Testversands) eine Konfigurationsänderung bleibt, kein Umbau.
