import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { ApiError, toApiError } from '../api/client';
import { Button } from './Button';

export type ToastTone = 'info' | 'success' | 'error';

export interface Toast {
  id: number;
  tone: ToastTone;
  message: string;
}

export interface ToastApi {
  info: (message: string) => void;
  success: (message: string) => void;
  error: (message: string) => void;
  /** Renders an `ApiError` message plus its field detail when present. */
  apiError: (error: unknown) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

const AUTO_DISMISS_MS = 6000;

export function ToastProvider({ children }: { children: ReactNode }): JSX.Element {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);

  const dismiss = useCallback((id: number) => {
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  const push = useCallback(
    (tone: ToastTone, message: string) => {
      const id = nextId.current++;
      setToasts((current) => [...current.slice(-3), { id, tone, message }]);
    },
    [],
  );

  useEffect(() => {
    if (toasts.length === 0) return undefined;
    const timer = window.setTimeout(() => {
      setToasts((current) => current.slice(1));
    }, AUTO_DISMISS_MS);
    return () => window.clearTimeout(timer);
  }, [toasts]);

  const api = useMemo<ToastApi>(
    () => ({
      info: (message) => push('info', message),
      success: (message) => push('success', message),
      error: (message) => push('error', message),
      apiError: (error) => {
        const typed = toApiError(error);
        const detail =
          typed instanceof ApiError && typed.fields.length > 0
            ? ` (${typed.fields.map((f) => `${f.path}: ${f.message}`).join('; ')})`
            : '';
        push('error', `${typed.message}${detail}`);
      },
    }),
    [push],
  );

  return (
    <ToastContext.Provider value={api}>
      {children}
      {/* Assertive so failures interrupt; the region is a polite live area otherwise. */}
      <div className="toast-region" role="region" aria-label="Notifications" aria-live="polite">
        {toasts.map((toast) => (
          <div
            key={toast.id}
            className={`toast toast--${toast.tone}`}
            role={toast.tone === 'error' ? 'alert' : 'status'}
          >
            <span className="grow">{toast.message}</span>
            <Button
              variant="ghost"
              size="sm"
              iconOnly
              aria-label="Dismiss notification"
              onClick={() => dismiss(toast.id)}
            >
              ✕
            </Button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastApi {
  const context = useContext(ToastContext);
  if (context === null) throw new Error('useToast must be used inside a ToastProvider');
  return context;
}
