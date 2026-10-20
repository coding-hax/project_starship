# Bedrohungsmodell: Admin-Bereich

Bezug: Epic #1199, S7 #1224 (Abschluss-Härtung). ADR-0031 legt die
Mehrbenutzer-Grenze fest (Rolle an `users`, je Anfrage frisch aus der DB
gelesen); dieses Dokument listet je Angriffsfläche des Admin-Bereichs den
Angriff, die Abwehr und den Test, der rot wird, wenn die Abwehr bricht.

## `/admin` (Seite)

| Angriff | Abwehr | Test |
| --- | --- | --- |
| Nicht-Admin ruft `/admin` direkt auf | `(admin)/layout.tsx` prüft `session.role === 'admin'` nach `getSession()`, nicht nur `middleware.ts`s Cookie-Check | `tests/admin-sicherheit.spec.ts` „AK5 (Seite)" |
| Antwort verrät, dass `/admin` existiert (Information Disclosure über Routing) | Nicht-Admin landet byte-gleich auf derselben Antwort wie eine echte, nicht existierende Route (`ADMIN_NOT_FOUND_PATH`, über `redirect()`, nicht `notFound()` — Begründung in `src/auth/admin-route.ts`) | `tests/admin-sicherheit.spec.ts` „AK5 (Seite)" |
| Admin wird mitten in der Sitzung herabgestuft/gesperrt, alte Berechtigung bleibt über das Cookie hinweg gültig | Rolle/`blocked_at` werden bei jeder Anfrage frisch aus der DB gelesen (`session.ts` `requireUser`/`requireAdmin`), nie aus Cookie/Header/Body | `tests/admin-sicherheit.spec.ts` „AK3" |
| Gespeichertes XSS über einen Konto-Anzeigenamen (`account.label`) | Reine JSX-Interpolation in `admin-overview.tsx`, kein `dangerouslySetInnerHTML` unter `src/features/admin/` oder `src/app/(admin)/` | `tests/admin-sicherheit.spec.ts` „AK7" |
| Admin-HTML landet im Service-Worker-Cache und bleibt nach dem Abmelden lesbar | `NetworkOnly`-Regel in `src/app/sw.ts` vor `defaultCache` für `/admin*` | `tests/admin-cache.prod.spec.ts` |
| Zwischenspeicherung durch Proxy/Browser-Cache | `Cache-Control: no-store` in `src/middleware.ts` für `/admin`-Präfix | `tests/admin-cache.prod.spec.ts` |

## `/api/admin/*` (API)

| Angriff | Abwehr | Test |
| --- | --- | --- |
| Eine spätere Route unter `src/app/api/admin/` vergisst die Rollenprüfung | Jede Route ruft `guardAdmin()` (`src/auth/admin-route.ts`); ein Vitest liest jede `route.ts`-Datei per `fs` und verlangt den Aufruf wörtlich | `src/auth/admin-route.test.ts` „jede Route unter src/app/api/admin/ ruft guardAdmin( auf" |
| Nicht-Admin fragt `/api/admin/accounts` direkt ab | `guardAdmin()` → `NotAdminError` → byte-gleiche „existiert nicht"-Antwort | `tests/admin-sicherheit.spec.ts` „AK5 (API)" |
| Admin wird mitten in der Sitzung herabgestuft/gesperrt | s. o. (Rolle/Sperre je Anfrage frisch) | `tests/admin-sicherheit.spec.ts` „AK3" |
| CSRF: ein fremder Origin löst eine mutierende Admin-Aktion über das vorhandene Admin-Cookie aus | `guardAdmin(req,{mutating:true})` verlangt `Origin === relyingParty().origin`, sonst 403 — unabhängig vom gültigen Cookie | `tests/admin-sicherheit.spec.ts` „AK6" (fremder/fehlender Origin) |
| GET löst versehentlich eine Aktion aus und bräuchte dieselbe Abwehr | Kein `GET`-Handler unter `src/app/api/admin/` mutiert; der einzige `GET` (`accounts/route.ts`) ist rein lesend | `tests/admin-sicherheit.spec.ts` „AK6: GET … löst keine Aktion aus" |
| Rechteausweitung über Eingaben (z. B. `role`/`user_id`/`blocked_at` im Body) | Keine Admin-Route liest Rolle/Konto-Identität aus dem Request-Body; `register/verify` setzt `role: 'user'` hart, `userId`/`inviteId` kommen aus der serverseitigen Challenge-Zeile | `tests/einladung.spec.ts` „AK4 (#1224)" |
| Geklaute Sitzung/unbeaufsichtigtes Gerät löst eine irreversible Aktion aus (Konto löschen, Journal löschen, Zugang neu ausstellen) | Diese drei Routen verlangen zusätzlich zu `guardAdmin()` eine frische WebAuthn-Bestätigung mit User Verification (`verifyStepUp()`, 5-Min-TTL, Einmaligkeit) | `tests/admin-aktionen.spec.ts` „AK10: … ohne Step-up scheitert mit 403" (×3) + Erfolgsfälle mit echter Zeremonie |
| Admin löscht sich selbst oder sperrt sich aus | Jede Aktions-Route lehnt `targetId === admin.userId` ab; das letzte Admin-Konto ist serverseitig vor dem Löschen geschützt | `tests/admin-aktionen.spec.ts` „AK6", „AK6/AK10", „AK7" |
| Antwort einer Aktions-Route leckt Nutzerinhalt (Aufgaben, Journal-Klartext, …) | Aktions-Routen geben nur Status/Metadaten zurück, nie synchronisierte Nutzerzeilen | `tests/admin-aktionen.spec.ts` „AK9" |
| Zwischenspeicherung der Kontoliste durch Proxy/Browser-Cache | `Cache-Control: no-store` in `src/middleware.ts` für `/api/admin`-Präfix | `tests/admin-sicherheit.spec.ts` „AK8" |

## `/einladung/<token>`

| Angriff | Abwehr | Test |
| --- | --- | --- |
| Token erraten/brute-force | `randomBytes(32)` (256 Bit, ≥128 Bit gefordert), Fixed-Window-Rate-Limit auf `register/options` | `src/auth/invite.test.ts` „erzeugt ein base64url-Token aus mindestens 128 Bit Zufall", `tests/einladung.spec.ts` „AK7" |
| Token-Leak über `Referer`-Header, wenn die Einladungsseite auf eine fremde Ressource verlinkt | `Referrer-Policy: no-referrer` für `/einladung`-Präfix (`src/middleware.ts`); die Seite lädt ohnehin keine fremden Ressourcen | `tests/admin-sicherheit.spec.ts` „AK9" |
| Token-Leak über die API-Antwort (DB/Logs geben den Klartext ein zweites Mal preis) | `verifyInvite()` gibt nur `id`/`userId` zurück, nie das Token selbst; die DB speichert nur `token_hash` | `src/auth/invite.test.ts` „gibt nie das Token selbst zurück", `tests/einladung.spec.ts` „AK1" |
| Token nach Ablauf oder zweitem Einlösen weiter gültig | `expires_at`-Prüfung + `UPDATE … RETURNING` macht das Einlösen atomar einmalig | `tests/einladung.spec.ts` „AK3", „AK4" |
| Timing-/Fehlerunterschied verrät, ob ein Token abgelaufen oder nie existiert hat | Abgelaufener und unbekannter Token geben identische Antwort | `tests/einladung.spec.ts` „AK5" |

## Registrierungs-Routen (`register/options`, `register/verify`)

| Angriff | Abwehr | Test |
| --- | --- | --- |
| Registrierung ohne Einladung, Sitzung oder Recovery-Code (altes „leere DB öffnet Registrierung"-Loch) | `register/options` verlangt immer eines der drei Bindungen, auch bei leerer Datenbank | `tests/einladung.spec.ts` „AK5" |
| Rechteausweitung über ein `role`-Feld im `register/verify`-Body | Serverseitig hart `role: 'user'`, Body wird für Identität/Rolle nicht gelesen | `tests/einladung.spec.ts` „AK4 (#1224)" |
| Brute-Force auf Invite-Tokens über wiederholte `register/options`-Versuche | Fixed-Window-Rate-Limit, fail-open bei DB-Fehler bewusst in Kauf genommen (Verfügbarkeit vor Abwehr) | `tests/einladung.spec.ts` „AK7" |

## `scripts/bootstrap-admin.ts`

| Angriff | Abwehr | Test |
| --- | --- | --- |
| Zweiter Lauf legt ein zweites Admin-Konto an oder stiehlt die erste Einladung | Script bricht sofort ab, wenn bereits ein Admin-Konto existiert (`findAdminUserId()`) | `tests/einladung.spec.ts` „AK6" |
| Script läuft versehentlich gegen eine produktive, bereits besiedelte DB | Dieselbe „existiert bereits ein Admin"-Prüfung greift unabhängig von der Umgebung | `tests/einladung.spec.ts` „AK6" |

## Service-Worker-Cache

| Angriff | Abwehr | Test |
| --- | --- | --- |
| `/admin`-Dokument oder `/api/admin/*`-Antwort landet im Cache Storage und bleibt nach dem Abmelden auf demselben Gerät lesbar | `adminNetworkOnly`-Regel (`NetworkOnly`) sitzt in `src/app/sw.ts` vor `defaultCache`, dessen `NetworkFirst`/`StaleWhileRevalidate`-Einträge sonst zuerst griffen | `tests/admin-cache.prod.spec.ts` |

## Restrisiken

- **Credential-IDs im `login/options`-`allowCredentials`** sind nicht geheim
  (vgl. Kommentar dort) — ein Leser erfährt daraus nur, dass irgendein Passkey
  existiert, nie wessen Konto welche Rolle hat. Kein Test dafür, weil es
  bewusst kein Geheimnis ist.
- **Token-Klartext in Logs.** Die Anwendung loggt Request-Bodies nicht; dass
  ein künftiger Logging-Aufruf versehentlich einen Invite- oder
  Step-up-Token mitschreibt, ist durch Code-Disziplin ausgeschlossen, nicht
  durch einen automatisierten Test — ein Test kann die Abwesenheit eines
  zukünftigen `console.log`-Aufrufs nicht vorwegnehmen.
- **`fail-open` bei Rate-Limit-Fehlern.** `src/auth/rate-limit.ts` lässt eine
  Anfrage durch, wenn die DB-Abfrage fürs Limit selbst fehlschlägt
  (Verfügbarkeit vor Abwehr, bewusste Abwägung aus #1202) — unter einem
  gleichzeitigen DB-Ausfall ist das Invite-/Login-Budget für diesen Moment
  wirkungslos. Kein eigener Test, da das Verhalten ein bewusster Kompromiss
  ist, kein Fund.
- **Admin ohne registrierten Passkey.** `register/verify` erzwingt bei jeder
  Kontoerstellung eine Passkey-Registrierung, ein Admin-Konto ohne Credential
  sollte es also nicht geben — stünde eines doch ohne da (z. B. durch
  manuellen DB-Eingriff), könnte es sich über die drei Step-up-pflichtigen
  Aktionen aussperren, nicht aber selbst gefährden: `verifyStepUp()` schlägt
  dann einfach immer fehl (403), keine Umgehung.
