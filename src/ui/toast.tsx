'use client';

export interface ToastProps {
  message: string;
  actionLabel: string;
  onAction: () => void;
  onDismiss: () => void;
}

/**
 * A calm confirmation, not an alert (docs/DESIGN_SYSTEM.md "Zustände") — `role="status"`
 * already implies `aria-live="polite"`, so nothing here needs a loud colour.
 */
export function Toast({ message, actionLabel, onAction, onDismiss }: ToastProps) {
  return (
    <div className="toast" role="status">
      <span className="toast__message">{message}</span>
      <button type="button" className="toast__action" onClick={onAction}>
        {actionLabel}
      </button>
      <button type="button" className="toast__dismiss" onClick={onDismiss} aria-label="Schließen">
        <span aria-hidden="true">×</span>
      </button>
    </div>
  );
}
