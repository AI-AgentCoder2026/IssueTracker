import { useId, type ReactNode, type SelectHTMLAttributes } from 'react';
import { cx } from '../lib/format';

export interface SelectOption<T extends string | number> {
  value: T;
  label: string;
  disabled?: boolean;
}

export interface SelectProps<T extends string | number>
  extends Omit<SelectHTMLAttributes<HTMLSelectElement>, 'value' | 'onChange' | 'children'> {
  label: string;
  value: T;
  options: ReadonlyArray<SelectOption<T>>;
  onChange: (value: T) => void;
  /** Rendered before the options; use for an explicit "any" choice. */
  placeholder?: string;
  /** Server-reported field error, rendered next to the control. */
  error?: string | null;
  hint?: string;
  hideLabel?: boolean;
}

function toValue<T extends string | number>(raw: string, options: ReadonlyArray<SelectOption<T>>): T {
  const match = options.find((option) => String(option.value) === raw);
  if (match !== undefined) return match.value;
  const fallback = options[0];
  return fallback !== undefined ? fallback.value : ('' as T);
}

/** Labelled `<select>` that reports the selected *value*, not the raw string. */
export function Select<T extends string | number>({
  label,
  value,
  options,
  onChange,
  placeholder,
  error,
  hint,
  hideLabel = false,
  className,
  id,
  ...rest
}: SelectProps<T>): JSX.Element {
  const generatedId = useId();
  const controlId = id ?? generatedId;
  const errorId = `${controlId}-error`;
  const hintId = `${controlId}-hint`;

  return (
    <div className={cx('field', className)}>
      <label className={cx('field-label', hideLabel && 'visually-hidden')} htmlFor={controlId}>
        {label}
      </label>
      <select
        {...rest}
        id={controlId}
        className="select"
        value={String(value)}
        aria-invalid={error !== undefined && error !== null ? true : undefined}
        aria-describedby={cx(error && errorId, hint && hintId) || undefined}
        onChange={(event) => onChange(toValue(event.target.value, options))}
      >
        {placeholder !== undefined ? <option value="">{placeholder}</option> : null}
        {options.map((option) => (
          <option key={String(option.value)} value={String(option.value)} disabled={option.disabled}>
            {option.label}
          </option>
        ))}
      </select>
      {error !== undefined && error !== null ? (
        <span className="field-error" id={errorId}>
          {error}
        </span>
      ) : null}
      {hint !== undefined && hint !== '' ? (
        <span className="field-hint" id={hintId}>
          {hint}
        </span>
      ) : null}
    </div>
  );
}

export interface FieldProps {
  label: string;
  htmlFor: string;
  error?: string | null;
  hint?: ReactNode;
  children: ReactNode;
  className?: string;
}

/** Wrapper that pairs a label, control and server-reported field error. */
export function Field({ label, htmlFor, error, hint, children, className }: FieldProps): JSX.Element {
  return (
    <div className={cx('field', className)}>
      <label className="field-label" htmlFor={htmlFor}>
        {label}
      </label>
      {children}
      {error !== undefined && error !== null ? <span className="field-error">{error}</span> : null}
      {hint !== undefined ? <span className="field-hint">{hint}</span> : null}
    </div>
  );
}
