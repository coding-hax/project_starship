'use client';

import { Row } from '@/ui/row';
import { SectionCard } from '@/ui/section-card';
import { useNavOrder } from './use-nav-order';

/**
 * Reihenfolge der Navigationseinträge (issue #205). Nur ↑/↓ statt Drag & Drop — dafür
 * bräuchte es entweder eine neue Dependency oder eine zweite Fassung des Drag-Codes
 * aus task-item.tsx, beides zu viel für diesen Zuschnitt (siehe Plan im Ticket).
 */
export function NavOrderPanel() {
  const { items, moveUp, moveDown } = useNavOrder();

  return (
    <SectionCard title="Reihenfolge der Navigation">
      {items.map((item, index) => (
        <Row key={item.id} label={item.label}>
          <div className="nav-order-panel__buttons">
            <button
              type="button"
              className="nav-order-panel__button"
              aria-label={`${item.label} nach oben`}
              disabled={index === 0}
              onClick={() => moveUp(item.id)}
            >
              ↑
            </button>
            <button
              type="button"
              className="nav-order-panel__button"
              aria-label={`${item.label} nach unten`}
              disabled={index === items.length - 1}
              onClick={() => moveDown(item.id)}
            >
              ↓
            </button>
          </div>
        </Row>
      ))}
    </SectionCard>
  );
}
