/**
 * Session state.
 *
 * The server issues an httpOnly cookie *and* returns the session id; we keep the
 * id in `localStorage` as the `Authorization` fallback and clear it on any 401,
 * which drops the user back to `/login`.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { onUnauthorized, restoreSessionId, setSessionId } from '../api/client';
import { authApi } from '../api/repo';
import type { PublicUser } from '../api/types';
import { Spinner } from '../components/Spinner';

export interface AuthContextValue {
  user: PublicUser | null;
  /** True while the initial `/api/auth/me` probe is in flight. */
  isLoading: boolean;
  isAuthenticated: boolean;
  login: (login: string, password: string) => Promise<void>;
  register: (input: {
    username: string;
    email: string;
    displayName: string;
    password: string;
  }) => Promise<void>;
  redeemGuestToken: (token: string) => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }): JSX.Element {
  const [user, setUser] = useState<PublicUser | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    // No stored session: skip the round trip entirely so the login page paints
    // immediately instead of flashing a spinner.
    if (restoreSessionId() === null) {
      setIsLoading(false);
      return () => {
        cancelled = true;
      };
    }
    authApi
      .me()
      .then((me) => {
        if (!cancelled) setUser(me);
      })
      .catch(() => {
        // A failed probe means "not signed in"; the stored id is dropped.
        if (!cancelled) {
          setSessionId(null);
          setUser(null);
        }
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(
    () =>
      onUnauthorized(() => {
        setUser(null);
      }),
    [],
  );

  const login = useCallback(async (login: string, password: string) => {
    const result = await authApi.login(login, password);
    setSessionId(result.sessionId);
    setUser(result.user);
  }, []);

  const register = useCallback(
    async (input: { username: string; email: string; displayName: string; password: string }) => {
      const result = await authApi.register(input);
      setSessionId(result.sessionId);
      setUser(result.user);
    },
    [],
  );

  const redeemGuestToken = useCallback(async (token: string) => {
    const result = await authApi.redeemGuestToken(token);
    setSessionId(result.sessionId);
    setUser(result.user);
  }, []);

  const logout = useCallback(async () => {
    try {
      await authApi.logout();
    } finally {
      setSessionId(null);
      setUser(null);
    }
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({
      user,
      isLoading,
      isAuthenticated: user !== null,
      login,
      register,
      redeemGuestToken,
      logout,
    }),
    [user, isLoading, login, register, redeemGuestToken, logout],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (context === null) throw new Error('useAuth must be used inside an AuthProvider');
  return context;
}

/** Full-page gate shown while the session probe runs. */
export function AuthGate({ children }: { children: ReactNode }): JSX.Element {
  const { isLoading } = useAuth();
  if (isLoading) {
    return (
      <div className="login-page" role="status" aria-live="polite">
        <div className="row">
          <Spinner label="Restoring your session" />
          <span className="muted">Restoring your session…</span>
        </div>
      </div>
    );
  }
  return <>{children}</>;
}
