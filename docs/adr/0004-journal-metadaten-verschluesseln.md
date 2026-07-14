# ADR-0004: Journal — auch Stimmung und Tags werden verschlüsselt

Status: **angenommen** · Datum: 2026-07-14
Ersetzt: den Metadaten-Absatz aus ADR-0001 §4 (dort blieben Datum, Stimmung und Tags im Klartext).

## Kontext

ADR-0001 §4 hielt Datum, Stimmung und Tags bewusst unverschlüsselt, „damit Filter
serverseitig gehen" — und stellte die Entscheidung ausdrücklich zur Disposition:
„Wenn das zu viel ist, werden auch die Tags verschlüsselt — bitte bewusst entscheiden."

Diese Entscheidung ist jetzt getroffen.

## Entscheidung

Verschlüsselt wird **alles außer `entry_date`**: Text, Stimmung und Tags liegen
gemeinsam in **einem** AES-GCM-Chiffrat.

`journal_entries` trägt damit: die vier Pflicht-Spalten, `entry_date` (Klartext),
`ciphertext`, `nonce`. **Keine** `mood`-Spalte, **keine** `tags`-Spalte.

## Begründung

Der serverseitige Filter, den ADR-0001 schützen wollte, wird nie gebraucht. In einer
Local-first-App läuft **jede** Abfrage gegen IndexedDB — Stimmungsverlauf, Tag-Filter
und Statistiken entstehen lokal und sind dort schneller als jeder Roundtrip.
Der Preis der Verschlüsselung ist damit praktisch null, der Gewinn real:
Der Server erfährt nur noch, _dass_ an einem Tag ein Eintrag existiert.

Das entspricht Produktprinzip 4 der Vision („Meine Daten bleiben meine") konsequenter
als der bisherige Kompromiss.

## Konsequenzen

- **Ein Chiffrat, nicht drei.** Stimmung und Tags gehören in denselben verschlüsselten
  Block wie der Text. Eigene verschlüsselte Spalten wären ein Fehler: bei
  deterministischer Verschlüsselung erzeugt derselbe Tag denselben Chiffretext, und
  der Server könnte über Häufigkeiten Rückschlüsse ziehen — Verschlüsselung, die
  nichts verschlüsselt.
- Nonce ist pro Eintrag zufällig und wird mitgespeichert.
- Keine serverseitige Filterung, Sortierung oder Aggregation über Journalinhalte.
  Bewusst akzeptiert.
- Der Server kennt weiterhin `entry_date`. Er weiß also, an welchen Tagen geschrieben
  wurde — nicht was. Das ist der bewusst gezahlte Rest-Preis; ohne ihn wäre kein
  inkrementeller Sync möglich.
- `docs/ARCHITECTURE.md` (Abschnitt „Journal: Ende-zu-Ende-Verschlüsselung") und die
  Datenmodell-Skizze sind entsprechend angepasst.
