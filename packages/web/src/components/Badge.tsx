import type { ReactNode } from 'react';
import { cx } from '../lib/format';

export type BadgeTone = 'neutral' | 'accent' | 'danger' | 'warning' | 'success' | 'info';

export interface BadgeProps {
  tone?: BadgeTone;
  /** Renders a leading dot; useful for state readouts. */
  dot?: boolean;
  children: ReactNode;
  className?: string;
  title?: string;
}

export function Badge({ tone = 'neutral', dot = false, children, className, title }: BadgeProps): JSX.Element {
  return (
    <span
      className={cx('badge', tone !== 'neutral' && `badge--${tone}`, dot && 'badge--dot', className)}
      title={title}
    >
      {children}
    </span>
  );
}
