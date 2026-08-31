# Modell-Eskalation beim Bauen (ADR-0007)

Bleibt ein Ticket in der Bau-Rolle dreimal in Folge ohne Fortschritt stecken,
schaltet der Runner eine Modellstufe hoch: von der Startstufe (`sonnet`, oder
was `model:*` sagt) → `opus`. Auf `opus` baut der Versuch tatsächlich Code.

Seit ADR-0013 ist das nicht mehr der einzige Weg dorthin: Du kannst die
**Startstufe** am Ticket setzen (`model:opus`), wenn vorher klar ist, dass es
schwer wird — dann entfallen die drei Läufe, die absehbar nichts liefern. Die
Präzedenz von stark nach schwach:

```
tier-<nr> gesetzt (schon eskaliert)  ->  diese Stufe
model:*-Label am Ticket              ->  dessen Stufe   (auch bei plan/research)
Rolle plan/research                  ->  opus
sonst                                ->  sonnet
```

Das Label ist der **Start**, nicht die Fessel: Eine schon eingetretene
Eskalation schlägt es, sonst hinge ein `model:sonnet`-Ticket für immer auf
Sonnet fest. Welche Stufe **gerade** läuft, steht im Titel des Status-Issues
(„arbeitet an #266 (opus, seit 18:49)") — die laufende Stufe selbst bleibt in
`.runner/tier-<nr>` und wird bewusst nicht als Label geführt: Sie gehört dem
Runner, nicht dir.

Ein Ticket, das mit `model:opus` startet, hat die Leiter schon oben betreten —
`tierBump()` hat von dort keinen Sprung mehr, drei erfolglose Läufe führen
also direkt zu „Eskalation erschöpft" + `needs-answer`.

- **Fortschritt** = neuer Commit auf dem Feature-Branch (Vergleich der
  Branch-Spitze auf `origin` vor/nach dem Lauf). Fortschritt setzt Stufe und
  Fehlversuchs-Zähler zurück.
- **Kein Fortschritt** = kein neuer Commit **und** dieselbe Blocker-Signatur
  wie im Vorlauf (siehe #33). Ein Lauf, der durch Limit oder Notbremse
  unterbrochen wurde, zählt nie als Fehlversuch.
- **Fertig, wartet auf CI/AK-Check (#961):** Ein Bau-Lauf, der sich mit
  `check` bewusst für inhaltlich fertig erklärt, ist ebenfalls kein
  Fehlversuch, selbst wenn die Branch-Spitze steht — der Fehlerzähler bleibt
  unangetastet, keine Eskalation, kein `opus-boost`-Abzug, keine
  F26-Auffälligkeit. Der Opus-Deckel parkt ein solches Ticket auch nicht unter
  `blocked-limit`: steht nur noch der AK-Check an, ist kein Bau-Schritt offen,
  gegen den der Deckel überhaupt greifen dürfte. Der Grund wird ausschließlich
  am `check`-Label nach dem Lauf festgemacht (derselbe Ort wie bei
  `needs-answer`), nie an einer Heuristik über den Transkript-Text — ein
  Lauf, der fälschlich „fertig" meldet, ohne `check` gesetzt zu haben, zählt
  weiterhin normal als Fehlversuch.
- **Auffälligkeit (F26/#499):** Steht die Branch-Spitze, hat der Lauf aber
  trotzdem einen Fortschrittskommentar angelegt, ist das schlimmer als ein
  gewöhnlicher Fehlversuch — die gemeldete Arbeit ist nicht durch Git gedeckt,
  und der nächste Lauf würde ihr glauben. Erkannt wird das über `createdAt`
  des Kommentars gegen den Laufbeginn (`runStart`), nicht über
  `updatedAt`/`lastEditedAt` — `gh` liefert beide durchweg `null`, auch bei
  nachweislich editierten Kommentaren. Der Runner schreibt dann einen
  **eigenen, sichtbaren** Kommentar am Ticket. Nie `--edit-last`, kein
  `needs-answer` (die Meldung ist informativ, keine Frage) — der
  Fortschrittskommentar selbst bleibt unangetastet, der Wert liegt darin,
  dass ein Mensch die durch Git nicht gedeckte Aussage sieht. Die gewöhnliche
  Eskalationslogik (failcount/Tier) läuft davon unbeeinflusst weiter.
- Bleibt Opus als höchste Stufe ebenfalls dreimal ohne Fortschritt: Stop,
  Label `needs-answer`, Blocker-Kommentar am Ticket.
- **Opus-Deckel:** höchstens 2 Opus-Bau-Läufe pro Ticket und Kalendertag.
  Überschreitung → sofort `needs-answer`, kein weiterer Opus-Bau-Versuch an
  diesem Tag. Die Meldung erscheint höchstens einmal je Ticket und Tag und
  nennt `opus-boost` als Ausweg vom Handy: das Label hebt die Zwei-Grenze für
  dieses Ticket auf, ohne den Zähler zu nullen, und wird von einem Opus-Lauf
  ohne Fortschritt wieder abgezogen. `no-escalation` gewinnt gegen
  `opus-boost`.
- Zustand liegt dateibasiert unter `.runner/` (`tier-<nr>`, `failcount-<nr>`,
  `opus-<datum>-<nr>`, `opus-cap-msg-<datum>-<nr>`) und überlebt Neustarts.

Details und Begründung: `docs/adr/0007-opus-eskalation-baut.md`.

**Dein Handy-Workflow:** Frage kommt als Issue-Kommentar rein (GitHub-App pingt
dich) → du antwortest als Kommentar → du entfernst `needs-answer` → das Ticket
wird beim nächsten Lauf (max. 20 Minuten später) fortgesetzt, nicht neu
gestartet (Mechanik siehe „Wartend ist nicht in Arbeit" in
`docs/workflow/zyklus.md`). In der
Zwischenzeit hat der Runner an anderen Tickets weitergearbeitet, nicht
stillgestanden.
