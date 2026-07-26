# Garmin-Bootstrap

Einmaliger, manueller Handgriff (ADR-0011) — die App meldet sich nie selbst bei
Garmin an. Fällig etwa einmal jährlich, wenn `/api/garmin-sync` mit `409` antwortet
("Kein OAuth1-Token hinterlegt" / "OAuth1-Token ist abgelaufen").

Kein Code führt diesen Ablauf automatisch aus. Er ist reverse-engineered
(inoffiziell, siehe ADR-0011, „Risiken") — bricht Garmin die SSO-Seite um, müssen
die Schritte unten ggf. angepasst werden. Die MIT-lizenzierten Referenzen (`garth`,
`garminconnect`) sind der Ort, an dem man zuerst nachsieht, falls es nicht mehr
klappt.

## Voraussetzungen

- Ein Garmin-Connect-Account mit Zugriff auf die gewünschten Aktivitäten.
- Ein Browser mit DevTools (Netzwerk-Tab).
- `psql`-Zugriff auf die Produktions-Postgres (`DATABASE_URL`).

## Schritte

1. **Neues Inkognito-Fenster**, DevTools öffnen, Netzwerk-Tab, „Preserve log"
   aktivieren, bevor irgendetwas geladen wird.
2. `https://sso.garmin.com/sso/embed?service=https%3A%2F%2Fconnect.garmin.com%2Fmodern`
   aufrufen und normal einloggen (inkl. 2FA, falls aktiv).
3. Im Netzwerk-Tab die Weiterleitung nach `connect.garmin.com/modern?ticket=ST-…`
   suchen und den kompletten `ticket`-Wert (`ST-…`) kopieren — das Service-Ticket,
   gültig nur wenige Minuten.
4. Das Ticket sofort gegen ein OAuth1-Token tauschen:

   ```bash
   curl -s "https://connectapi.garmin.com/oauth-service/oauth/preauthorized?ticket=<ST-…>&login-url=https://sso.garmin.com/sso/embed&accepts-mfa-tokens=true" \
     -H "User-Agent: com.garmin.android.apps.connectmobile"
   ```

   Die Antwort enthält `oauth_token` und `oauth_token_secret` als Query-Parameter
   einer Callback-URL — das ist das OAuth1-Token-Paar, Standzeit ≈ 1 Jahr.

5. In Postgres hinterlegen (ersetzt ein vorhandenes `oauth1`-Token, falls eines da
   ist — `garmin_tokens.kind` ist `unique`):

   ```sql
   INSERT INTO garmin_tokens (id, kind, token, expires_at, updated_at)
   VALUES (
     gen_random_uuid(),
     'oauth1',
     jsonb_build_object('token', '<oauth_token>', 'tokenSecret', '<oauth_token_secret>'),
     now() + interval '1 year',
     now()
   )
   ON CONFLICT (kind) DO UPDATE
   SET token = excluded.token, expires_at = excluded.expires_at, updated_at = now();
   ```

6. **Kein manueller OAuth2-Eintrag nötig** — `/api/garmin-sync` erneuert das
   OAuth2-Token beim nächsten Lauf selbst aus dem OAuth1-Token
   (`src/features/garmin/tokens.ts`) und schreibt es zurück.
7. Testen: `curl -X POST "$APP_URL/api/garmin-sync" -H "Authorization: Bearer $GARMIN_SYNC_SECRET"`
   sollte `200` mit Zählern antworten, nicht `409`.

## Nach dem Bootstrap

Das Service-Ticket aus Schritt 3 ist danach wertlos (schon eingelöst) — nirgends
aufbewahren. Nur das OAuth1-Token-Paar in Postgres zählt.
