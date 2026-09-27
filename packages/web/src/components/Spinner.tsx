import { cx } from '../lib/format';

export interface SpinnerProps {
  /** Accessible label announced while loading. */
  label?: string;
  className?: string;
}

/** Indeterminate progress indicator, used inside buttons and busy rows. */
export function Spinner({ label = 'Loading', className }: SpinnerProps): JSX.Element {
  return (
    <span className={cx('spinner', className)} role="status" aria-live="polite">
      <span className="visually-hidden">{label}</span>
    </span>
  );
}
