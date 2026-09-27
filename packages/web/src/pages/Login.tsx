import { useEffect, useState, type FormEvent } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import {
  fromWebAuthnJSON,
  isCredentialAborted,
  isWebAuthnAvailable,
  toWebAuthnJSON,
} from '@tracker/shared';
import { useAuth } from '../auth/AuthContext';
import { ApiError, setSessionId } from '../api/client';
import { passkeyApi } from '../api/repo';
import { Button } from '../components/Button';
import { Field } from '../components/Select';
import { useToast } from '../components/Toast';

type Mode = 'login' | 'register' | 'guest';

const TITLES: Record<Mode, string> = {
  login: 'Sign in',
  register: 'Create an account',
  guest: 'Use a guest link',
};

/** Login, registration and guest-token redemption in one screen. */
export function Login(): JSX.Element {
  const { isAuthenticated, login, register, redeemGuestToken } = useAuth();
  const navigate = useNavigate();
  const toast = useToast();
  const [mode, setMode] = useState<Mode>('login');
  const [busy, setBusy] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const [loginName, setLoginName] = useState('');
  const [password, setPassword] = useState('');
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [guestToken, setGuestToken] = useState('');

  // Passkeys are only offered when the browser can actually use them, so the
  // page never shows a button that cannot work.
  const [passkeysAvailable, setPasskeysAvailable] = useState(false);
  const [passkeyBusy, setPasskeyBusy] = useState(false);

  useEffect(() => {
    setPasskeysAvailable(isWebAuthnAvailable());
  }, []);

  const signInWithPasskey = async (): Promise<void> => {
    setPasskeyBusy(true);
    try {
      const begun = await passkeyApi.beginAuthentication(loginName.trim() || undefined);
      const credential = (await navigator.credentials.get({
        publicKey: fromWebAuthnJSON(begun.options),
      })) as unknown;
      if (!credential) throw new Error('No credential was returned');

      const result = await passkeyApi.finishAuthentication({
        response: toWebAuthnJSON(credential),
        challengeId: begun.challengeId,
      });
      setSessionId(result.sessionId);
      navigate('/projects', { replace: true });
    } catch (error) {
      // Dismissing the platform sheet is a choice, not a failure.
      if (isCredentialAborted(error)) return;
      toast.error(error instanceof Error ? error.message : 'Could not sign in with a passkey');
    } finally {
      setPasskeyBusy(false);
    }
  };

  if (isAuthenticated) return <Navigate to="/projects" replace />;

  const collectFieldErrors = (error: unknown): void => {
    if (error instanceof ApiError) {
      const next: Record<string, string> = {};
      for (const field of error.fields) next[field.path] = field.message;
      setFieldErrors(next);
    }
  };

  const onSubmit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    setBusy(true);
    setFieldErrors({});
    try {
      if (mode === 'login') {
        await login(loginName, password);
        toast.success('Signed in');
        void navigate('/projects');
      } else if (mode === 'register') {
        await register({ username, email, displayName, password });
        toast.success('Account created');
        void navigate('/projects');
      } else {
        await redeemGuestToken(guestToken.trim());
        toast.success('Guest access granted');
        void navigate('/projects');
      }
    } catch (error) {
      collectFieldErrors(error);
      toast.apiError(error);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login-page">
      <div className="card card-pad login-card">
        <div className="row" style={{ marginBottom: 'var(--space-4)' }}>
          <span className="brand-mark" aria-hidden="true">
            IT
          </span>
          <div>
            <h1>Issue Tracker</h1>
            <p className="subtle" style={{ margin: 0 }}>
              Self-hosted issue tracking with GitLab sync
            </p>
          </div>
        </div>

        <div className="login-tabs" role="tablist" aria-label="Authentication method">
          {(['login', 'register', 'guest'] as const).map((option) => (
            <button
              key={option}
              type="button"
              role="tab"
              className="login-tab"
              aria-selected={mode === option}
              onClick={() => {
                setMode(option);
                setFieldErrors({});
              }}
            >
              {TITLES[option]}
            </button>
          ))}
        </div>

        <form className="stack" onSubmit={(event) => void onSubmit(event)} noValidate>
          {mode === 'login' ? (
            <>
              <Field label="Email or username" htmlFor="login-name" error={fieldErrors.login}>
                <input
                  id="login-name"
                  className="input"
                  value={loginName}
                  autoComplete="username"
                  required
                  aria-invalid={fieldErrors.login !== undefined}
                  onChange={(event) => setLoginName(event.target.value)}
                />
              </Field>
              <Field label="Password" htmlFor="login-password" error={fieldErrors.password}>
                <input
                  id="login-password"
                  className="input"
                  type="password"
                  value={password}
                  autoComplete="current-password"
                  required
                  aria-invalid={fieldErrors.password !== undefined}
                  onChange={(event) => setPassword(event.target.value)}
                />
              </Field>
            </>
          ) : null}

          {mode === 'register' ? (
            <>
              <Field label="Username" htmlFor="reg-username" error={fieldErrors.username}>
                <input
                  id="reg-username"
                  className="input"
                  value={username}
                  autoComplete="username"
                  required
                  aria-invalid={fieldErrors.username !== undefined}
                  onChange={(event) => setUsername(event.target.value)}
                />
              </Field>
              <Field label="Email" htmlFor="reg-email" error={fieldErrors.email}>
                <input
                  id="reg-email"
                  className="input"
                  type="email"
                  value={email}
                  autoComplete="email"
                  required
                  aria-invalid={fieldErrors.email !== undefined}
                  onChange={(event) => setEmail(event.target.value)}
                />
              </Field>
              <Field label="Display name" htmlFor="reg-display" error={fieldErrors.displayName}>
                <input
                  id="reg-display"
                  className="input"
                  value={displayName}
                  autoComplete="name"
                  required
                  aria-invalid={fieldErrors.displayName !== undefined}
                  onChange={(event) => setDisplayName(event.target.value)}
                />
              </Field>
              <Field
                label="Password"
                htmlFor="reg-password"
                error={fieldErrors.password}
                hint="At least 12 characters, with upper case, lower case and a digit."
              >
                <input
                  id="reg-password"
                  className="input"
                  type="password"
                  value={password}
                  autoComplete="new-password"
                  required
                  aria-invalid={fieldErrors.password !== undefined}
                  onChange={(event) => setPassword(event.target.value)}
                />
              </Field>
            </>
          ) : null}

          {mode === 'guest' ? (
            <Field
              label="Guest token"
              htmlFor="guest-token"
              error={fieldErrors.token}
              hint="Paste the token from a shared guest link."
            >
              <input
                id="guest-token"
                className="input"
                value={guestToken}
                required
                aria-invalid={fieldErrors.token !== undefined}
                onChange={(event) => setGuestToken(event.target.value)}
              />
            </Field>
          ) : null}

          <Button type="submit" variant="primary" block loading={busy}>
            {TITLES[mode]}
          </Button>
        </form>

        {mode === 'login' && passkeysAvailable ? (
          <div className="stack-sm">
            <hr />
            <Button variant="default" block onClick={() => void signInWithPasskey()} loading={passkeyBusy}>
              Sign in with a passkey
            </Button>
            <p className="subtle">
              Uses Face ID, Touch ID, a fingerprint or your device's screen lock — no
              password.
            </p>
          </div>
        ) : null}
      </div>
    </div>
  );
}
