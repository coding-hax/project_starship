# Fundschlüssel & Pflichtsuche (#366)

Am 29.07.26 lagen drei offene Tickets für denselben roten Test
(`tests/aktivitaeten.spec.ts:608`, AC6 Stand-Hinweis): #349, #351 und #364 —
drei verschiedene Hypothesen-Titel, keiner fand die anderen beiden. Deshalb
gilt für jedes Fund-Ticket eine feste Form.

**Titel- und Body-Form.** Ein Fund-Ticket wird nach dem *Testort* benannt,
nicht nach der Vermutung, und trägt den Schlüssel maschinenlesbar im Body:

```
Titel: fund(<pfad>:<zeile>): kurze Beschreibung des Fehlschlags
Body:  Fund: <pfad>:<zeile>
```

Die `Fund:`-Zeile muss am Zeilenanfang stehen (Fließtext, das „Fund:“ nur
erwähnt, zählt nicht) — `parseFindKeys()` in `scripts/runner/queue.ts` liest
genau das.

**Mehrzeilige Form — ein Root-Cause, ein Ticket (#410).** Belegen mehrere
rote Tests dieselbe vermutete Ursache, trägt **ein** Ticket mehrere
`Fund:`-Zeilen statt N getrennter Tickets:

```
Body:  Fund: <pfad-a>:<zeile-a>
       Fund: <pfad-b>:<zeile-b>
```

Getrennte Tickets nur bei getrennten Ursachen. Die einzeilige Form bleibt
für den Normalfall (ein Testort) weiterhin gültig — `parseFindKeys()` liest
beide Formen gleich und `findFoundTicket()` trifft ein Ticket über **jeden**
seiner Schlüssel.

**Kein Fund ohne Reproduktion (#410).** Bevor ein neues Fund-Ticket entsteht,
sind die zwei bekannten Umgebungsfallen ausgeschlossen: `pnpm install` ist im
benutzten Arbeitsbaum gelaufen (fehlendes `tsx` färbt **alle** Bash-Suiten
unter `scripts/tests/` rot und tarnt sich als Fachfehler) und der Lauf
benutzt `env -u STATE_DIR -u REPO_DIR` (sonst greifen die Suiten auf das
echte `.runner/` zu). Alternativ genügt ein CI-Beleg, dass derselbe Check
dort rot ist. Ist keins von beidem erfüllt, entsteht **kein Ticket** —
stattdessen eine Zeile im Fortschrittskommentar des laufenden Tickets. Der
Body nennt, wie reproduziert wurde (Arbeitsbaum + Kommandozeile, oder ein
Link auf den roten CI-Job) — ohne diesen Nachweis ist es kein Fund, sondern
ein Verdacht. Grund: #404–#407 am 30.07.26, vier Tickets für einen Fehler,
der nur im Extra-Worktree ohne `pnpm install`/mit geerbtem
`STATE_DIR`/`REPO_DIR` auftrat — auf `origin/main` liefen dieselben Suiten
grün.

**Pflichtsuche vor `gh issue create`.** Bevor ein neues Fund-Ticket entsteht,
wird gegen den Schlüssel gesucht, **mit `--state all`**:

```
gh issue list --state all --search '"Fund: <pfad>:<zeile>"'
```

`--state all` ist wesentlich: ein geschlossener Flake, der wiederkommt,
gehört ans alte Ticket, nicht in ein neues.

**Trefferpolitik.** Ein Treffer bekommt einen Kommentar statt eines neuen
Tickets — welcher Treffer, hängt vom Zustand ab:

- **Offen, nicht `in-progress`:** Kommentar am bestehenden Ticket.
- **Offen und `in-progress`:** eingeschränkt seit #410 — siehe „Ein
  Fund-Ticket in Arbeit wird nicht ergänzt“ unten, dort gilt eine eigene
  Regel statt des einfachen Kommentars.
- **Geschlossen als `not planned`/Duplikat:** Kommentar am alten Ticket
  **und wieder öffnen** — ein als unerheblich abgetaner Fund ist damit nie
  wirklich erledigt gewesen.
- **Geschlossen als erledigt (der Fix ist gemerged):** ein **neues** Ticket,
  das das alte verlinkt — ein Rückfall nach einem gemergten Fix ist eine neue
  Tatsache, kein Fortsetzen des alten.

Mehrere Treffer auf denselben Schlüssel: das **älteste** Ticket gewinnt
(`findFoundTicket()`), denn das ist das ursprüngliche — alles danach war
bereits ein vermeidbares Duplikat.

**Der Runner hilft mit, verlässt sich aber nicht allein auf die Suche.** Der
Auftragstext eines Baulaufs listet die bekannten, untriagierten Fund-Tickets
mit Schlüssel bereits mit („## Bekannte Fund-Tickets“), sofern welche
existieren — mechanisch, nicht nur vorgeschrieben. Das fängt vor allem den
Fall, dass ein *offenes* Geschwister-Ticket in einem anderen Slot lief, als
der Fund entstand (genau der teure Fall bei #364). Die Pflichtsuche bleibt
trotzdem nötig: sie fängt die **geschlossenen** Geschwister, die im
Auftragstext naturgemäß nicht auftauchen.

**Geschwister-Vermerk (#410).** Legt ein Lauf mehrere Fund-Tickets an, trägt
jedes im Body `Geschwister: #a #b #c` (die jeweils anderen). Der Bau-Prompt
verlangt, diese Geschwister-Tickets vor dem eigentlichen Bauen zu lesen —
berühren zwei davon dieselbe Datei oder denselben Test, wird das im
Fortschrittskommentar benannt statt blind gebaut. Grund: Vorfall am 30.07.26
— #394 baute einen Test, der beweist, dass ein verdrängter Eintrag als
Konflikt-Kopie landet, #395 entfernte unabhängig davon genau den Producer,
der diese Kopie schreibt. Beide wurden getrennt geplant und gebaut; die
Kollision fiel erst in der CI auf.

**Ein Fund-Ticket in Arbeit wird nicht ergänzt (#410).** `foundTickets()`
reicht durch, ob ein Fund-Ticket das Label `in-progress` trägt; der
Auftragstext markiert das sichtbar (`#404 \`key\` (in Arbeit — nicht
ergänzen)`). Das schränkt die obige Trefferpolitik für den offenen Fall ein:

- **Nichts Neues** (derselbe Test, derselbe Fehler): gar nichts tun, kein
  Kommentar, weitergehen — kein zweiter Bauplatz für dieselbe Erkenntnis.
- **Neue Information** (ein anderer Fehler, eine zweite Ursache): ein
  eigenes Ticket mit demselben `Fund:`-Schlüssel plus `Nachtrag zu #X` im
  Body — auffindbar über den gemeinsamen Schlüssel, kein blindes zweites
  Ticket wie vor #366.

Ausgenommen bleiben der bauende Lauf selbst (Fortschritts-, Blocker- und der
Pflichtkommentar bei sensiblen Pfaden bleiben unverändert Pflicht) und der
Mensch.
