import type { ReactNode } from 'react';
import './page-head.css';

interface PageHeadProps {
  /** Augenbrauenzeile über dem Titel — z. B. das lange Datum, ein Zähler. */
  eyebrow?: ReactNode;
  /** Titelzeile: Titel links + Figur/Ring im selben Fluss (issue #833 AK3). */
  children: ReactNode;
  /** Zusatz-Slot unter der Titelzeile — Unterzeile ODER eine Chip-Reihe, nie beides. */
  extra?: ReactNode;
  /** Bisheriger Routen-Klassenname der Titelzeile (z. B. `uebersicht__title-row`) —
      erhält die bestehenden Locator aus figuren.spec.ts/seitenkopf.spec.ts ohne Umbau. */
  rowClassName?: string;
  /** Durchreichte Routen-Attribute (globals.css `[data-ground]`/`[data-modules-off]`) — der
      äußere `.page-head` ist ihr Träger, wie zuvor die routeneigene Titelzeile. */
  dataGround?: string;
  dataModule?: string;
}

/**
 * Drei-Zonen-Kopf, gemeinsames Bauteil für die neun Routen-Köpfe (issue #868,
 * T1 von #861). Server-Komponente ohne Hooks (wie `faces.tsx`) — die Routen
 * liefern Titel/Cluster/Aktionen selbst, damit die Anti-Layout-Shift-Regeln
 * aus #652/#862 (weiterhin in der jeweiligen Routen-CSS) erhalten bleiben.
 *
 * `border-radius: 0`, kein Verlauf (page-head.css) — das hält
 * `seitenkopf.spec.ts` AK1 (`assertFlatHeader`) grün.
 */
export function PageHead({
  eyebrow,
  children,
  extra,
  rowClassName,
  dataGround,
  dataModule,
}: PageHeadProps) {
  return (
    <div className="page-head" data-ground={dataGround} data-module={dataModule}>
      {eyebrow !== undefined && <div className="page-head__eyebrow">{eyebrow}</div>}
      <div className={rowClassName ? `page-head__title-row ${rowClassName}` : 'page-head__title-row'}>
        {children}
      </div>
      {extra !== undefined && <div className="page-head__extra">{extra}</div>}
    </div>
  );
}
