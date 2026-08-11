import type { ReactNode } from 'react';
import './offline-notice.css';

export interface OfflineNoticeProps {
  children: ReactNode;
}

/**
 * Shared shape for the offline notice each view renders in its own words
 * (docs/design/formwahl-und-zustaende.md) — text stays per-caller, only the
 * `role="status"` (implies `aria-live="polite"`, a calm note, not an alert)
 * and the look are shared.
 */
export function OfflineNotice({ children }: OfflineNoticeProps) {
  return (
    <p role="status" className="offline-notice">
      {children}
    </p>
  );
}
