export interface RowProps {
  label: string;
  description?: string;
  children: React.ReactNode;
}

/**
 * Label left, control right — the base layout for every settings line
 * (ADR-0006). Motionless on purpose: only the control inside animates.
 */
export function Row({ label, description, children }: RowProps) {
  return (
    <div className="row">
      <div className="row__text">
        <span className="row__label">{label}</span>
        {description && <span className="row__description">{description}</span>}
      </div>
      <div className="row__control">{children}</div>
    </div>
  );
}
