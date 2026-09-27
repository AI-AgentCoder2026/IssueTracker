import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Button } from './Button';

export interface ModalProps {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
  /** Blocks backdrop/Escape dismissal while a write is in flight. */
  busy?: boolean;
}

const FOCUSABLE =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Focus-trapping dialog rendered in a portal, dismissible with Escape. */
export function Modal({
  open,
  title,
  onClose,
  children,
  footer,
  wide = false,
  busy = false,
}: ModalProps): JSX.Element | null {
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement | null>(null);
  const restoreFocus = useRef<Element | null>(null);

  useEffect(() => {
    if (!open) return undefined;
    restoreFocus.current = document.activeElement;
    const panel = panelRef.current;
    const first = panel?.querySelector<HTMLElement>(FOCUSABLE);
    (first ?? panel)?.focus();

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !busy) {
        event.stopPropagation();
        onClose();
        return;
      }
      if (event.key !== 'Tab' || !panel) return;
      const focusable = [...panel.querySelectorAll<HTMLElement>(FOCUSABLE)];
      const firstEl = focusable[0];
      const lastEl = focusable[focusable.length - 1];
      if (firstEl === undefined || lastEl === undefined) return;
      if (event.shiftKey && document.activeElement === firstEl) {
        event.preventDefault();
        lastEl.focus();
      } else if (!event.shiftKey && document.activeElement === lastEl) {
        event.preventDefault();
        firstEl.focus();
      }
    };

    document.addEventListener('keydown', onKeyDown, true);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      document.body.style.overflow = previousOverflow;
      if (restoreFocus.current instanceof HTMLElement) restoreFocus.current.focus();
    };
  }, [open, busy, onClose]);

  if (!open) return null;

  return createPortal(
    <div
      className="modal-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onClose();
      }}
    >
      <div
        className={wide ? 'modal modal--wide' : 'modal'}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        ref={panelRef}
        tabIndex={-1}
      >
        <div className="modal-header">
          <h2 id={titleId}>{title}</h2>
          <Button
            variant="ghost"
            size="sm"
            iconOnly
            onClick={onClose}
            aria-label="Close dialog"
            disabled={busy}
          >
            ✕
          </Button>
        </div>
        <div className="modal-body">{children}</div>
        {footer !== undefined ? <div className="modal-footer">{footer}</div> : null}
      </div>
    </div>,
    document.body,
  );
}

export interface ConfirmDialogProps {
  open: boolean;
  title: string;
  message: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

/** Replaces `window.confirm` so destructive actions are explicit and styled. */
export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  destructive = false,
  busy = false,
  onConfirm,
  onCancel,
}: ConfirmDialogProps): JSX.Element | null {
  return (
    <Modal
      open={open}
      title={title}
      onClose={onCancel}
      busy={busy}
      footer={
        <>
          <Button onClick={onCancel} disabled={busy}>
            {cancelLabel}
          </Button>
          <Button variant={destructive ? 'danger' : 'primary'} onClick={onConfirm} loading={busy}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div className="muted">{message}</div>
    </Modal>
  );
}

export interface ConfirmRequest {
  title: string;
  message: ReactNode;
  confirmLabel?: string;
  destructive?: boolean;
}

export interface ConfirmApi {
  /** Opens the dialog and resolves `true` when confirmed, `false` on cancel. */
  confirm: (request: ConfirmRequest) => Promise<boolean>;
  dialog: JSX.Element | null;
}

interface ConfirmState {
  open: boolean;
  title: string;
  message: ReactNode;
  confirmLabel: string;
  destructive: boolean;
  onConfirm: () => void;
}

const CLOSED: ConfirmState = {
  open: false,
  title: '',
  message: null,
  confirmLabel: 'Confirm',
  destructive: false,
  onConfirm: () => undefined,
};

/**
 * Hook form of the confirm dialog: one `confirm()` call, one `dialog` to render
 * wherever the calling component lives.
 */
export function useConfirm(): ConfirmApi {
  const [state, setState] = useState<ConfirmState>(CLOSED);
  const resolver = useRef<((value: boolean) => void) | null>(null);

  const close = useCallback((result: boolean) => {
    setState(CLOSED);
    resolver.current?.(result);
    resolver.current = null;
  }, []);

  const confirm = useCallback(
    (request: ConfirmRequest) => {
      setState({
        open: true,
        title: request.title,
        message: request.message,
        confirmLabel: request.confirmLabel ?? 'Confirm',
        destructive: request.destructive ?? false,
        onConfirm: () => close(true),
      });
      return new Promise<boolean>((resolve) => {
        resolver.current = resolve;
      });
    },
    [close],
  );

  const dialog = (
    <ConfirmDialog
      open={state.open}
      title={state.title}
      message={state.message}
      confirmLabel={state.confirmLabel}
      destructive={state.destructive}
      onConfirm={state.onConfirm}
      onCancel={() => close(false)}
    />
  );

  return { confirm, dialog };
}
