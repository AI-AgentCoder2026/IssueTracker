import type { ReactNode } from 'react';
import { Button } from './Button';

export interface EmptyStateProps {
  title: string;
  description?: ReactNode;
  icon?: string;
  action?: { label: string; onClick: () => void };
}

/** Shown whenever a query succeeds but returns nothing renderable. */
export function EmptyState({ title, description, icon = '∅', action }: EmptyStateProps): JSX.Element {
  return (
    <div className="empty-state">
      <div className="empty-state__icon" aria-hidden="true">
        {icon}
      </div>
      <p className="empty-state__title">{title}</p>
      {description !== undefined ? <p className="muted">{description}</p> : null}
      {action !== undefined ? (
        <Button variant="primary" size="sm" onClick={action.onClick}>
          {action.label}
        </Button>
      ) : null}
    </div>
  );
}

export interface ErrorStateProps {
  title?: string;
  error: unknown;
  onRetry?: () => void;
}

/** Never swallow a failure: every data view renders this when its query fails. */
export function ErrorState({ title = 'Something went wrong', error, onRetry }: ErrorStateProps): JSX.Element {
  const message = error instanceof Error ? error.message : String(error);
  const code = error instanceof Error && 'code' in error ? String((error as { code: unknown }).code) : null;
  return (
    <div className="error-state" role="alert">
      <p className="empty-state__title">{title}</p>
      <p>{message}</p>
      {code !== null ? <p className="error-state__detail">{code}</p> : null}
      {onRetry !== undefined ? (
        <Button size="sm" onClick={onRetry}>
          Try again
        </Button>
      ) : null}
    </div>
  );
}
