'use client';

import { useState } from 'react';
import { downloadExport } from './export';

type Status = 'idle' | 'exporting' | 'error';

/**
 * The one control in Einstellungen for now: pull everything out of IndexedDB into a
 * downloadable JSON file. No server round-trip, so it works offline too.
 */
export function ExportPanel() {
  const [status, setStatus] = useState<Status>('idle');

  async function handleExport() {
    setStatus('exporting');
    try {
      await downloadExport();
      setStatus('idle');
    } catch (error) {
      console.error('[export] failed', error);
      setStatus('error');
    }
  }

  return (
    <section className="export">
      <h2>Daten</h2>
      <p className="export__hint">
        Lädt eine JSON-Datei mit allen lokalen Datensätzen herunter, inklusive gelöschter
        Einträge. Funktioniert auch offline — die Daten liegen bereits auf diesem Gerät.
      </p>
      <button
        type="button"
        className="export__button"
        onClick={handleExport}
        disabled={status === 'exporting'}
      >
        {status === 'exporting' ? 'Exportiere …' : 'Alles exportieren'}
      </button>
      {status === 'error' && (
        <p className="export__error" role="alert">
          Export fehlgeschlagen. Bitte erneut versuchen.
        </p>
      )}
    </section>
  );
}
