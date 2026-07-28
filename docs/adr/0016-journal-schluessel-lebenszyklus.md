# ADR-0016: Journal-Schlüssel-Lebenszyklus auf dem Gerät

Status: **vorgeschlagen** · Datum: 2026-07-28
Baut auf ADR-0004 und der Envelope-Entscheidung (DEK/KEK) aus ADR-0015 (#54) auf; ergänzt bei Annahme den Abschnitt „Journal: Ende-zu-Ende-Verschlüsselung" in docs/ARCHITECTURE.md.

## Kontext

Das Journal ist Ende-zu-Ende-verschlüsselt (ADR-0004): Text, Stimmung und Tags liegen in einem Chiffrat, nur entry_date bleibt Klartext. Die Envelope-Struktur (ADR-0015) leitet aus der Passphrase einen KEK ab, der den eigentlichen Datenschlüssel (DEK) entpackt. Offen war: wie lange lebt der *entpackte* DEK auf dem Gerät? Randbedingungen: iOS-Homescreen-PWAs werden im Hintergrund aggressiv beendet; storage.persist() (M1) schützt IndexedDB, nicht den JS-Heap; Geräte-Neustart; mehrere Tabs. Zusatzbedingung: die Übersicht muss funktionieren, während das Journal gesperrt ist (Produktprinzip 1). Ein CryptoKey ist als extractable:false erzeugbar und via Structured Clone in IndexedDB speicherbar, ohne dass die Rohbytes je in JS sichtbar werden.

Der Owner hat in #301 die Variante C gewählt (Antwort „1c").

## Entscheidung (C — Mittelweg)

- **Default: speicherresident.** Der DEK wird beim Öffnen des Journals entpackt und als non-extractable CryptoKey nur im JS-Speicher gehalten — nie nach IndexedDB geschrieben. Beim nächsten Kaltstart wird wieder entsperrt.
- **Opt-in „Auf diesem Gerät entsperrt lassen" (per Default AUS).** Persistiert den non-extractable DEK-CryptoKey in IndexedDB; danach kein erneutes Entsperren, überlebt Neustart und PWA-Kill.
- **Auto-Lock nach Inaktivität.** Der speicherresidente DEK wird nach einem Zeitfenster verworfen; danach wieder Passphrase.
- **Mehrere Tabs.** Eine entsperrte Sitzung teilt den DEK via BroadcastChannel (ein non-extractable CryptoKey ist klonbar), damit nicht jeder Tab einzeln entsperrt.
- **Gesperrt-Zustand.** Nur das Journal ist zu, nie die App: ruhiger Entsperr-Zustand im Journal (Design-System „Zustände", kein roter Fehler). Die Übersicht liest ihren „heute geschrieben?"-Status allein aus dem Klartext-entry_date (ADR-0004), ganz ohne DEK.

## Begründung

Reines Memory-only scheitert an der iOS-PWA-Realität für ein *tägliches* Journal (ständige Re-Entsperrung → das Feature wird gemieden). Reines Persistieren höhlt das Bedrohungsmodell aus: der dauerhaft nutzbare DEK macht Gerätezugriff = Journalzugriff, die Verschlüsselung lokal faktisch wirkungslos. Der Mittelweg lässt den Nutzer bewusst wählen: sicherer Default, bequemes Opt-in.

## Konsequenzen

- Mehr Zustände (entsperrt / gesperrt / auto-lock) → entsprechende Tests im M4-Umsetzungs-Ticket.
- Der persistierte DEK bleibt non-extractable — der Rohschlüssel verlässt WebCrypto nie; das Opt-in verschiebt nur die Angriffsfläche auf „wer das entsperrte Gerät besitzt".
- Kein neuer Serverkontakt: DEK und BroadcastChannel bleiben clientseitig (Regel 9).
- Diese ADR ändert keinen Code. Umsetzung in M4. Bei Annahme wird der ARCHITECTURE-Abschnitt „Journal: Ende-zu-Ende-Verschlüsselung" um den Lebenszyklus ergänzt (eigener Folgeschritt).

## Verworfene Alternativen
- **A (nur persistiert):** höhlt das Bedrohungsmodell aus.
- **B (nur Memory):** zu viel Reibung auf iOS für tägliche Nutzung.
