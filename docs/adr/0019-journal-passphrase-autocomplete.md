# ADR-0019: Autocomplete/Name an den Journal-Passphrase-Feldern

Status: **angenommen** · Datum: 2026-07-30
Baut auf ADR-0004 (Ende-zu-Ende-Verschlüsselung) und ADR-0016 (Schlüssel-Lebenszyklus, „wer das Gerät hat, kommt rein" per Opt-in) auf.

## Kontext

Fund #392: die Passphrase-Eingaben in `journal-gate.tsx` (Einrichten, Entsperren,
Rewrap) hatten weder `name` noch `autocomplete`, wodurch iOS-Schlüsselbund und
andere Passwortmanager sie nicht als speicherbares Feld erkennen. Das
widerspricht der Zusage aus Regel 9 / ADR-0004 nicht direkt — die Passphrase
verlässt weiterhin nie unverschlüsselt das Gerät in Richtung Server —, berührt
aber die Erwartung, dass an Journal-Krypto beteiligte Felder bewusst behandelt
werden.

Der Recovery-Key-Bildschirm (`journal-gate.tsx:104-107`) empfiehlt heute schon
ausdrücklich, den Wiederherstellungsschlüssel im Passwortmanager abzulegen —
gleichwertiges Schlüsselmaterial liegt dort also bereits.

## Entscheidung (Variante A, Owner-Antwort im Issue-Kommentar vom 30.07.)

- `JournalSetupForm` und `JournalRewrapForm`: beide Felder je
  `autocomplete="new-password"`, mit `name="new-journal-passphrase"` bzw.
  `name="new-journal-passphrase-confirm"`.
- `JournalUnlockForm`: das eine Eingabefeld schaltet zwischen Passphrase- und
  Recovery-Modus um, `autocomplete`/`name` folgen diesem Modus:
  - Passphrase-Modus: `autocomplete="current-password"`,
    `name="journal-passphrase"`.
  - Recovery-Modus: `autocomplete="off"`, kein `name` — der Recovery-Key soll
    nicht zusätzlich als „neues Passwort" vorgeschlagen werden.

`name` löst keine native Formular-Submission aus; alle `handleSubmit`
verhindern das Standardverhalten bereits per `preventDefault`. Die Attribute
dienen ausschließlich der Heuristik der Passwortmanager.

## Begründung

Ohne diese Attribute bietet kein Passwortmanager an, die Passphrase zu
speichern oder beim Entsperren automatisch einzusetzen — Reibung, die bei
einem täglich genutzten Journal (ADR-0016) zu schwachen oder wiederverwendeten
Passphrasen verleitet. Die Recovery-Eingabe bleibt bewusst ausgenommen, damit
der Manager sie nicht mit einer neuen Passphrase verwechselt.

## Konsequenz und bewusst akzeptierter Preis

Die Passphrase kann dadurch über den Passwortmanager (z. B. iCloud-Schlüsselbund)
in Apples Infrastruktur synchronisieren. Akzeptiert, weil:

- gleichwertiges Schlüsselmaterial (der Recovery-Key) schon heute dorthin
  empfohlen wird,
- ADR-0016 mit dem Opt-in „Auf diesem Gerät entsperrt lassen" bereits
  akzeptiert, dass Gerätezugriff faktisch Journalzugriff bedeuten kann,
- die Chiffrate selbst (Regel 9) davon unberührt bleiben — nur die Passphrase
  als Zugangsmittel ist betroffen, nicht der Journal-Inhalt.

Rückweg: die `name`/`autocomplete`-Attribute entfernen, diese ADR zurückziehen.

## Verworfene Alternativen

- **B (nichts ändern):** Fund #392 bliebe unbehoben, Passwortmanager-Unterstützung
  fehlt weiterhin.
- **C (nur `autocomplete`, kein `name`):** verworfen — manche Passwortmanager
  verlassen sich zusätzlich auf `name` zur Feld-Klassifizierung, ohne wäre die
  Erkennung unzuverlässiger, ohne zusätzlichen Sicherheitsgewinn.
