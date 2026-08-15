'use client';

import { AppearancePanel } from '@/features/settings/appearance-panel';
import { ModulePanel } from '@/features/settings/module-panel';
import { NavOrderPanel } from '@/features/settings/nav-order-panel';
import { PushPanel } from '@/features/settings/push-panel';
import { SessionPanel } from '@/features/settings/session-panel';
import { useActiveSections } from '@/modules/module-sections';
import type { ComponentType } from 'react';

/** Panel order after the core ones: Aufgaben → Kalender → Wetter → Journal → Export (issue #308, #339, #560). */
const ORDER = ['aufgaben', 'kalender', 'wetter', 'journal', 'export'];

type GroupId = 'geraet' | 'module' | 'daten';

/**
 * Welcher Gruppe ein modulbasiertes Panel zugeordnet wird (issue #653). ICS-Abos
 * (Modul „kalender") steht nicht in der AK1-Aufzählung, gehört inhaltlich aber zu
 * „Module" — genau wie Wetter und Journal ist es die Konfiguration eines Moduls,
 * nicht des Geräts oder ein Datenexport.
 */
const MODULE_GROUP: Record<string, GroupId> = {
  aufgaben: 'geraet',
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

export function EinstellungenSections() {
  const sections = useActiveSections(ORDER, (m) => m.SettingsPanel);

  return (
    <div className="einstellungen__groups">
      {GROUPS.map((group) => {
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
