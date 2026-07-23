import { Row } from '@/ui/row';
import { SectionCard } from '@/ui/section-card';

/**
 * CC BY 4.0 requires the Open-Meteo attribution to be visible somewhere — it moved
 * here out of /heute, where it competed with the forecast itself (issue #155).
 */
export function AttributionPanel() {
  return (
    <SectionCard title="Datenquellen">
      <Row label="Wetterdaten">
        <a href="https://open-meteo.com/" target="_blank" rel="noreferrer">
          Open-Meteo
        </a>
      </Row>
    </SectionCard>
  );
}
