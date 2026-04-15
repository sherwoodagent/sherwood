import { type ReactNode } from "react";

interface EmptyStateProps {
  icon?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
}

export function EmptyState({ icon, title, description, action }: EmptyStateProps) {
  return (
    <div className="sh-empty" role="status">
      {icon && <div className="sh-empty__icon" aria-hidden="true">{icon}</div>}
      <div className="sh-empty__title">{title}</div>
      {description && <div className="sh-empty__desc">{description}</div>}
      {action && <div style={{ marginTop: "1rem" }}>{action}</div>}
    </div>
  );
}
