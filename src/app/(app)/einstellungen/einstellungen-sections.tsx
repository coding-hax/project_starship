'use client';

import { AppearancePanel } from '@/features/settings/appearance-panel';
import { DevicesPanel } from '@/features/settings/devices-panel';
import { LoginsPanel } from '@/features/settings/logins-panel';
import { ModulePanel } from '@/features/settings/module-panel';
import { NavOrderPanel } from '@/features/settings/nav-order-panel';
import { PushPanel } from '@/features/settings/push-panel';
import { SessionPanel } from '@/features/settings/session-panel';
import { useIsAdmin } from '@/features/settings/use-admin-role';
import { VerwaltungPanel } from '@/features/settings/verwaltung-panel';
import { useActiveSections } from '@/modules/module-sections';
import type { ComponentType } from 'react';

/** Panel order after the core ones: Aufgaben → Routinen → Kalender → Wetter → Journal → Export
 *  (issue #308, #339, #560, #1184). */
const ORDER = ['aufgaben', 'routinen', 'kalender', 'wetter', 'journal', 'export'];

type GroupId = 'geraet' | 'module' | 'daten' | 'verwaltung';

/**
 * Welcher Gruppe ein modulbasiertes Panel zugeordnet wird (issue #653). ICS-Abos
 * (Modul „kalender") steht nicht in der AK1-Aufzählung, gehört inhaltlich aber zu
 * „Module" — genau wie Wetter und Journal ist es die Konfiguration eines Moduls,
 * nicht des Geräts oder ein Datenexport.
 */
const MODULE_GROUP: Record<string, GroupId> = {
  aufgaben: 'geraet',
  routinen: 'module',
  kalender: 'module',
  wetter: 'module',
  journal: 'module',
  export: 'daten',
};

interface CorePanel {
  id: string;
  Component: ComponentType;
}

const GROUPS: Array<{ id: GroupId; title: string; core: CorePanel[] }> = [
  {
    id: 'geraet',
    title: 'Gerät',
    core: [
      { id: 'darstellung', Component: AppearancePanel },
      { id: 'benachrichtigungen', Component: PushPanel },
      { id: 'sitzung', Component: SessionPanel },
      { id: 'anmeldungen', Component: LoginsPanel },
      { id: 'geraete', Component: DevicesPanel },
    ],
  },
  {
    id: 'module',
    title: 'Module',
    core: [
      { id: 'module', Component: ModulePanel },
      { id: 'nav-order', Component: NavOrderPanel },
    ],
  },
  { id: 'daten', title: 'Daten', core: [] },
];

/**
 * Not a `GROUPS` entry: a static `core: [{ id: 'verwaltung', ... }]` would make
 * the group always non-empty (AK10) — a `user` account would still find an
 * empty-but-present "Verwaltung" `<h2>` in the DOM, which is exactly the leak
 * AK10 (mirroring AK1) forbids. Appending it only once `useIsAdmin()` resolves
 * `true` keeps a non-admin account's render identical to before this group
 * existed.
 */
const VERWALTUNG_GROUP = { id: 'verwaltung' as const, title: 'Verwaltung', core: [{ id: 'verwaltung', Component: VerwaltungPanel }] };

export function EinstellungenSections() {
  const sections = useActiveSections(ORDER, (m) => m.SettingsPanel);
  const isAdmin = useIsAdmin();
  const groups = isAdmin ? [...GROUPS, VERWALTUNG_GROUP] : GROUPS;

  return (
    <div className="einstellungen__groups">
      {groups.map((group) => {
        const items = [...group.core, ...sections.filter(({ id }) => MODULE_GROUP[id] === group.id)];
        if (items.length === 0) return null;
        return (
          <section key={group.id} className="einstellungen__group">
            <h2 className="einstellungen__group-title">{group.title}</h2>
            <div className="einstellungen__group-items">
              {items.map(({ id, Component }) => (
                <Component key={id} />
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}
