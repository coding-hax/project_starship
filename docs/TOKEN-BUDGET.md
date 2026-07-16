# Token-Budget

Das Kontingent ist die knappste Ressource im Projekt — knapper als Zeit.
Dieses Dokument legt fest, wofür wir es ausgeben.

**Grundsatz:** Verbrauch skaliert mit **Kontext**, nicht mit der Anzahl der Nachrichten.
Fünf Dateien beiläufig einlesen kostet mehr als zwanzig kurze Prompts.

---

## Modellpolitik

| Aufgabe                                    | Modell                           | Warum                                                                           |
| ------------------------------------------ | -------------------------------- | ------------------------------------------------------------------------------- |
| Architektur, ADRs, Tickets schreiben       | **Opus 4.8, Effort high**        | Hier zahlt sich Denktiefe aus. Ein guter Plan spart mehr Tokens, als er kostet. |
| Feature implementieren                     | **Sonnet 5**                     | Erledigt den Großteil der Codearbeit ohne spürbaren Qualitätsverlust.           |
| Mechanisch (Umbenennen, Doku, Boilerplate) | **Haiku** (Label `model:haiku`)  | Sonnet wäre Verschwendung.                                                      |
| Code suchen / verstehen                    | **Haiku** (Explore-Subagent)     | Eigenes Kontextfenster, der Suchmüll landet nie im Hauptlauf.                   |
| Tests ausführen                            | **Haiku** (test-runner-Subagent) | Gibt „3 rot, hier ist warum" statt 400 Zeilen Log.                              |

In Claude Code ist das Muster eingebaut: **`/model opusplan`** benutzt Opus im
Plan-Modus und schaltet für die Ausführung auf Sonnet um — ohne die Konversation
zu leeren, Sonnet sieht also alles, was Opus erarbeitet hat.

**Die eine harte Regel:** Opus mit Effort „high" ist die teuerste Kombination, die
es gibt. Sie ist für Architektur, Ticketschrieb und Bugs, an denen Sonnet zweimal
gescheitert ist. **Niemals** für Implementierung, niemals für Suchen, niemals im Runner
— außer in den zwei eng begrenzten, nur-lesenden Denk-Rollen (Planung, Feature-
Recherche) aus `docs/adr/0005-opus-im-runner.md` (kein Tages-Deckel, Kill-Switch
`no-opus`, nie Bauen) und der **Eskalations-Rolle** aus
`docs/adr/0007-opus-eskalation-baut.md`: Bleibt ein Ticket auf Sonnet/Haiku
dreimal ohne Fortschritt, baut Opus als letzte Stufe selbst — mit hartem Deckel
**max. 2 Opus-Bau-Läufe pro Ticket/Tag** und Kill-Switch `no-escalation`. Das ist
die einzige Stelle im Repo, an der Opus produktiv schreibt.

---

## Die Hebel, nach Wirkung sortiert

### 1. Deterministische Werkzeuge statt Tokens

Der am meisten unterschätzte Hebel. Kein Modell darf Tokens für etwas ausgeben,
das ein Skript umsonst erledigt:

- **Formatierung** → Prettier/ESLint per Hook, nicht per Modell
- **Migrationen** → `pnpm db:generate`, nicht handgeschrieben
- **UI-Boilerplate** → `npx shadcn add button`, nicht generiert
- **Typen** → aus dem Drizzle-Schema abgeleitet, nicht abgetippt

Hook in `.claude/settings.json`, damit nach jeder Dateiänderung automatisch
formatiert wird — dann gibt Claude nie ein Output-Token für Einrückung aus:

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Edit|Write",
        "hooks": [{ "type": "command", "command": "pnpm prettier --write $CLAUDE_FILE_PATHS" }]
      }
    ]
  }
}
```

### 2. Das Ticket liefert den Kontext

Jede Datei, die im Ticket steht, muss nicht gesucht werden. Der Abschnitt
„Betroffene Dateien" im Issue-Template ist kein Formalismus, er ist der Sparplan.

### 3. Suchen und Testen in Subagenten

Beide laufen auf Haiku in **eigenen** Kontextfenstern und geben nur die
Zusammenfassung zurück. Siehe `.claude/agents/`.

⚠️ **Nicht übertreiben:** Subagenten haben eigene Kontexte — flächendeckend
eingesetzt _vervielfachen_ sie den Verbrauch (Multi-Agent-Workflows liegen beim
4–7-fachen). Nur für lesende, klar begrenzte Aufgaben.

### 4. Tests laufen in CI

Die volle Playwright-Suite läuft auf GitHubs Rechnern und kostet null Tokens.
Claude führt lokal nur den Spec zum aktuellen Ticket aus.

### 5. Prompt-Caching nicht kaputt machen

Der stabile Präfix (System-Prompt, Tool-Definitionen, CLAUDE.md) wird gecacht und
ist dann drastisch billiger. **Jede Änderung an CLAUDE.md invalidiert den Cache.**
Also: CLAUDE.md schlank halten und _nicht dauernd anfassen_.

### 6. MCP-Server sparsam einsetzen

Die Tool-Definitionen jedes MCP-Servers liegen bei **jedem** Turn im Kontext.
Wir benutzen deshalb die `gh`-CLI über Bash statt eines GitHub-MCP-Servers.

### 7. Keine Bilder in den Hauptkontext

Screenshots sind teuer. Playwright macht sie nur bei Fehlschlag, und gelesen werden
sie vom test-runner-Subagenten — nicht vom Hauptlauf.

### 8. Kleine Tickets

Fünf kleine Tickets kosten weniger als ein großes, weil der Kontext pro Lauf
klein bleibt. Ein Ticket, das mehr als ~5 Dateien anfasst, wird geteilt.

---

## Geprüft und (vorerst) verworfen

**Graphify** — baut aus dem Repo einen abfragbaren Wissensgraphen (Tree-sitter,
lokal, MIT). Der Agent fragt den Graphen ab, statt Dateien zu lesen; für Claude Code
gibt es einen PreToolUse-Hook, der Glob/Grep abfängt. Beworben mit ~71-facher
Token-Reduktion pro Anfrage.

**Warum jetzt nicht:** Diese Ersparnis entsteht in großen, gewachsenen Codebasen.
Unser Repo startet bei null. Solange `docs/CODEMAP.md` die Frage „wo liegt was?"
beantwortet, leistet sie dasselbe — ohne Sync-Risiko (ein veralteter Graph gibt
falsche Antworten) und ohne den eigenen LLM-Pass, den der Graphaufbau kostet.

**Wann wir neu bewerten:** sobald `src/` mehr als ~50 Dateien hat, **oder** sobald
im Runner-Log auffällt, dass Claude regelmäßig durchs Repo grept, statt die Karte
zu benutzen. Dann als eigenes Ticket mit Vorher-Nachher-Messung.

Gleiches gilt für Kompressions-Layer (Headroom) und terse-output-Skills (Caveman):
erst die kostenlosen Hausmittel ausreizen, dann Drittwerkzeuge — jedes davon ist
eine Abhängigkeit, die gewartet werden will.
