import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { cx } from '../lib/format';
import { Spinner } from './Spinner';

export type ButtonVariant = 'default' | 'primary' | 'danger' | 'ghost';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: 'md' | 'sm';
  /** Renders a spinner and disables the control; the label stays for a11y. */
  loading?: boolean;
  /** Square button; `aria-label` is then required for icon-only usage. */
  iconOnly?: boolean;
  block?: boolean;
  children?: ReactNode;
}

/** The single button primitive; every actionable control in the app uses it. */
export function Button({
  variant = 'default',
  size = 'md',
  loading = false,
  iconOnly = false,
  block = false,
  disabled,
  className,
  children,
  type = 'button',
  ...rest
}: ButtonProps): JSX.Element {
  return (
    <button
      {...rest}
      type={type}
      disabled={disabled === true || loading}
      aria-busy={loading || undefined}
      className={cx(
        'btn',
        variant !== 'default' && `btn--${variant}`,
        size === 'sm' && 'btn--sm',
        iconOnly && 'btn--icon',
        block && 'btn--block',
        className,
      )}
    >
      {loading ? <Spinner label="Working" /> : null}
      {children}
    </button>
  );
}
