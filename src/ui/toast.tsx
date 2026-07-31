'use client';

import { createPortal } from 'react-dom';
import { useToastHostNode } from './toast-host';

export interface ToastProps {
  message: string;
  actionLabel: string;
  onAction: () => void;
  onDismiss: () => void;
  /**
   * `confirmation` (default) is a calm undo notice, `role="status"` (docs/DESIGN_SYSTEM.md
   * "Zustände") — nothing here needs a loud colour. `error` is a genuine `Fehler` state,
   * which the same section requires to look distinct: `role="alert"` and `--danger`.
   */
  variant?: 'confirmation' | 'error';
}

export function Toast({
  message,
  actionLabel,
  onAction,
  onDismiss,
  variant = 'confirmation',
}: ToastProps) {
  const hostNode = useToastHostNode();
  if (!hostNode) return null;

  return createPortal(
    <li
      className={variant === 'error' ? 'toast toast--error' : 'toast'}
      role={variant === 'error' ? 'alert' : 'status'}
    >
      <span className="toast__message">{message}</span>
      <button type="button" className="toast__action" onClick={onAction}>
        {actionLabel}
      </button>
      <button type="button" className="toast__dismiss" onClick={onDismiss} aria-label="Schließen">
        <span aria-hidden="true">×</span>
      </button>
    </li>,
    hostNode,
  );
}
