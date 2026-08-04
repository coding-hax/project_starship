# ADR-0021: Führung per Lease statt je Slot berechneter Meinung

Status: angenommen
Datum: 2026-08-03
Bezug: #488 (F14), ADR-0014, ADR-0020

## Kontext

Deep Review vom 02.08.26, Fund F14: `effectiveLead()` (`fleet.ts`) entscheidet
je Slot **für sich**, wer gerade Leitslot ist — anhand des zuletzt bekannten
Herzschlags aller Slots. Rund um die Frischegrenze (`STALE_MS`, 90 Min.) lesen
zwei Slots denselben Zustand unterschiedlich: für den einen ist `LEAD_SLOT`
gerade noch frisch, für den anderen gerade nicht mehr. Beide halten sich für
zuständig und fahren die globalen Wächter — `claimSweep`, Statusveröffentlichung,
`reopenFalselyClosedIssues` — gleichzeitig.

Verschärfend: `IS_LEAD` wurde bei Rundenbeginn festgehalten und vom
Hintergrund-Publisher (`start_fleet_publisher`, #331) bis zu
`FLEET_PUBLISH_INTERVAL` (Default 300s, innerhalb einer bis zu 45-minütigen
`claude`-Runde) unverändert weitergetragen — die Führung konnte in dieser Zeit
längst gewechselt haben.

Für sich genommen kosmetisch (doppelte Statuszeilen), zusammen mit dem
Sweep-Fund F10 (#482) aber nicht mehr: zwei gleichzeitige `claimSweep`-Läufe
sind zwei Chancen, einen lebenden Claim wegzuräumen.

## Entscheidung

### Zwei getrennte Schichten: Berechtigung vs. Ausschluss

`effectiveLead()` bleibt **unverändert** die Quelle der BERECHTIGUNG: bevorzugt
`LEAD_SLOT`, sonst der niedrigste Slot mit frischem Herzschlag. Sie steuert
weiterhin die Übernahme-Notiz in `aggregateStatus()` und die Failover-Reihenfolge
— die bestehenden Fleet-Tests bleiben grün (AK4), es gibt keinen Vertragsbruch.

Eine **Lease** unter `SHARED_DIR/lead/` (`lead.ts`, neu) liefert den
gegenseitigen AUSSCHLUSS obendrauf: auch wenn zwei Slots am Frischerand ihre
Berechtigung unterschiedlich berechnen, kann nur **einer** die Lease halten —
der andere ist nicht Leitslot, unabhängig davon, was er selbst für berechtigt
hält (AK1).

### Lease = Verzeichnis, atomare Umbenennung wie der Claim (ADR-0020)

`SHARED_DIR/lead/` mit einer Datei `holder` (`{slot, expiresAtMs}` JSON).
Verzeichnis, nicht Datei: `rename` auf ein **nicht-leeres** Zielverzeichnis
scheitert atomar (POSIX `ENOTEMPTY`) — genau ein Gewinner. Ein `rename` auf
eine Ziel-**Datei** würde sie ersetzen, kein Ausschluss. `tryAcquire()` legt
ein Temp-Verzeichnis mit befüllter `holder`-Datei an und hebt es per
`renameSync` an den finalen Pfad — dieselbe Technik wie `claimAtomic()`.

Ablauf statt PID-Liveness (wie beim Claim, ADR-0020-Begründung analog): der
Runner-Prozess stirbt planmäßig nach jedem Tick, ein `claude`-Aufruf kann
minutenlang laufen. `LEAD_TTL_MS = STALE_MS` (90 Min.) — Lease- und
Herzschlag-Ablauf fallen zusammen, kein zweiter frei gewählter Schwellwert.
Solange der Leitslot lebt und **jede Runde erneuert** (`renew()`, aus
`fleet-effective-lead` bzw. dem Keep-alive in `fleet-verify-lead`, Intervall
≪ TTL), ist seine Lease nie abgelaufen — ein zweiter Slot liest am Rand die
frische Lease und tritt nicht an. Ablauf nur, wenn der Leitslot ~90 Min. gar
nicht erneuert hat = wirklich tot → genau einer übernimmt per `tryReap()` +
`tryAcquire()` (AK2).

`tryReap()` räumt eine abgelaufene Lease selbst atomar weg (`renameSync` auf
ein Grab-Verzeichnis, ein zweiter gleichzeitiger Reaper scheitert mit
`ENOENT`) — nötig, weil `tryAcquire()` sonst am nicht-leeren, aber abgelaufenen
`leadDir` scheitern würde.

### Führung wird zum Zeitpunkt des Effekts geprüft, nicht bei Rundenbeginn

Neues Kommando `fleet-verify-lead`: prüft `ctx.lead.holds(slotId)` frisch,
Exit 0 (+ Keep-alive-`renew`) oder Exit 1. `claude-runner.sh` nutzt es an zwei
Stellen:

- `run_round()`: `IS_LEAD` kommt aus `fleet-verify-lead`, nicht mehr aus einem
  Vergleich `SLOT_ID = EFF_LEAD`.
- `apply_status()`: das Publish-Tor (`fleet-status` + `status()`) prüft
  `fleet-verify-lead` frisch bei JEDEM Aufruf — auch aus dem Hintergrund-
  Publisher, der `apply_status()` während eines laufenden `claude`-Aufrufs
  periodisch erneut ruft (AK3). Der Herzschlag (`fleet-write-state`) bleibt
  davon unabhängig immer geschrieben.

`reopenFalselyClosedIssues`/`claimSweep`/`watch-waiting-issues` bleiben am
`isLead`-Argument von `roundPlan` — sie laufen im Vordergrund zu Rundenbeginn,
also ohnehin „zum Zeitpunkt des Effekts" im Sinne von AK3 (die geforderte
Lücke ist der Hintergrund-Publisher). Kein Umbau an `roundPlan` nötig.

## Verworfen — bitte nicht erneut vorschlagen

- **`effectiveLead()` als alleinige Wahrheit belassen.** Genau das ist F14 —
  eine je Slot berechnete Meinung schließt gegenseitigen Ausschluss nicht ein,
  egal wie die Frischegrenze gezogen wird.
- **Lease als Datei statt Verzeichnis.** `rename` auf eine Ziel-Datei
  *ersetzt* sie, statt atomar zu scheitern — kein Ausschluss, zwei Slots
  könnten „gleichzeitig" schreiben.
- **Eine lebende Fremd-Lease stehlen** (z. B. wenn der lokale Slot sich selbst
  für entitled hält). Bricht den Ausschluss, den dieses ADR gerade einführt —
  der entitled-Slot bekommt die Lease beim NÄCHSTEN Tick, sobald der Halter sie
  freigibt oder abläuft, nicht durch Gewalt.
- **PID-Liveness statt TTL.** Wie beim Claim (ADR-0020): ein `claude`-Aufruf
  überlebt viele Ticks, PID-Liveness gäbe die Lease nach Minuten fälschlich
  frei.

## Risiko / Rückweg

Sensibler Pfad (`scripts/`). Fehlerbild bei einem Bug hier: doppelte oder
fehlende Führung — dieselbe Schadensklasse wie vor diesem ADR, nicht schlimmer.
Failsafe: `tryReap()` räumt nur eine nachweislich **abgelaufene** Lease weg;
stirbt ein Prozess zwischen Reap und Acquire, ist kurz niemand Leitslot
(harmlos, der nächste Tick übernimmt — wie zuvor „ruhender Leitslot besser als
keiner" in ADR-0014). Rückweg: rein additiv, ein Revert stellt die je-Slot-
Führung wieder her (`SHARED_DIR/lead/` bleibt ein verwaister, ignorierter
Ordner).

## Nicht-Ziele

Kein Umbau an `claim.ts` — #488 fasst den Claim-Mechanismus nicht an, kein
Konflikt mit #482 (F10), beide unabhängig in beliebiger Reihenfolge baubar.
Kein Umbau an `aggregateStatus()`/`effectiveLead()`s Kernlogik.
