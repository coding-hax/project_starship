import { ExportPanel } from '@/features/export/export-panel';

export const metadata = { title: 'Einstellungen · Starship' };

export default function EinstellungenPage() {
  return (
    <>
      <h1>Einstellungen</h1>
      <ExportPanel />
    </>
  );
}
