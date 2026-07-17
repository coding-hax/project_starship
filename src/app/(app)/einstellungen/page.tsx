import { ExportPanel } from '@/features/export/export-panel';
import { AppearancePanel } from '@/features/settings/appearance-panel';
import { CapturePanel } from '@/features/settings/capture-panel';

export const metadata = { title: 'Einstellungen · Starship' };

export default function EinstellungenPage() {
  return (
    <>
      <h1>Einstellungen</h1>
      <AppearancePanel />
      <CapturePanel />
      <ExportPanel />
    </>
  );
}
