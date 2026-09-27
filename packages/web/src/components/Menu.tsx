import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { cx } from '../lib/format';

export interface MenuProps {
  /** Accessible name of the trigger, also used as the menu's label. */
  label: string;
  children: ReactNode | ((close: () => void) => ReactNode);
  align?: 'left' | 'right';
  placement?: 'below' | 'above';
  triggerClassName?: string;
  renderTrigger?: (props: {
    open: boolean;
    toggle: () => void;
    ref: (node: HTMLButtonElement | null) => void;
  }) => ReactNode;
}

/**
 * Keyboard-operable dropdown: Escape closes, arrow keys move between items,
 * focus returns to the trigger, and a click outside dismisses.
 */
export function Menu({
  label,
  children,
  align = 'left',
  placement = 'below',
  triggerClassName,
  renderTrigger,
}: MenuProps): JSX.Element {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);

  const close = useCallback(() => {
    setOpen(false);
    triggerRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!open) return undefined;
    const onPointerDown = (event: MouseEvent): void => {
      if (rootRef.current !== null && !rootRef.current.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        close();
        return;
      }
      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
      const root = rootRef.current;
      if (root === null) return;
      const items = [...root.querySelectorAll<HTMLElement>('[role="menuitem"]')];
      if (items.length === 0) return;
      event.preventDefault();
      const index = items.indexOf(document.activeElement as HTMLElement);
      const delta = event.key === 'ArrowDown' ? 1 : -1;
      const next = ((index + delta) % items.length + items.length) % items.length;
      items[next]?.focus();
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown, true);
    };
  }, [close, open]);

  return (
    <div className="project-switcher" ref={rootRef}>
      {renderTrigger !== undefined ? (
        renderTrigger({
          open,
          toggle: () => setOpen((v) => !v),
          ref: (node) => {
            triggerRef.current = node;
          },
        })
      ) : (
        <button
          ref={triggerRef}
          type="button"
          className={cx('switcher-trigger', triggerClassName)}
          aria-haspopup="menu"
          aria-expanded={open}
          aria-label={label}
          onClick={() => setOpen((v) => !v)}
        >
          <span className="grow truncate" style={{ textAlign: 'left' }}>
            {label}
          </span>
          <span aria-hidden="true" className="subtle">
            ▾
          </span>
        </button>
      )}
      {open ? (
        <div
          className={cx('menu', align === 'right' ? 'menu--left' : '', placement === 'below' ? 'menu--below' : 'menu--above')}
          role="menu"
          aria-label={label}
        >
          {typeof children === 'function' ? children(close) : children}
        </div>
      ) : null}
    </div>
  );
}

export interface MenuItemProps {
  onSelect: () => void;
  children: ReactNode;
  current?: boolean;
  disabled?: boolean;
}

export function MenuItem({ onSelect, children, current, disabled }: MenuItemProps): JSX.Element {
  return (
    <button
      type="button"
      role="menuitem"
      className="menu-item"
      aria-current={current === true ? 'true' : undefined}
      disabled={disabled}
      onClick={onSelect}
    >
      {children}
    </button>
  );
}

export function MenuSeparator(): JSX.Element {
  return <div className="menu-separator" role="separator" />;
}
