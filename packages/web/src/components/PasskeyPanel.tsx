/**
 * Passkey management.
 *
 * Lets a signed-in user add a passkey, see which devices are registered, and
 * revoke one. The list distinguishes a device-bound key — where the sign-in is
 * gated behind Face ID, Touch ID or a fingerprint — from a synced or roaming
 * one, because those carry a different risk story and the UI should not imply
 * hardware protection where there is none.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  describeAttachment,
  fromWebAuthnJSON,
  isCredentialAborted,
  isPlatformAuthenticatorAvailable,
  isWebAuthnAvailable,
  toWebAuthnJSON,
  type PasskeyCredentialSummary,
} from '@tracker/shared';
import { passkeyApi } from '../api/repo';
import { useQuery } from '../api/hooks';
import { Badge } from './Badge';
import { Button } from './Button';
import { EmptyState } from './EmptyState';
import { Modal } from './Modal';
import { Spinner } from './Spinner';
import { formatDate } from '../lib/format';

interface PasskeyPanelProps {
  onError: (message: string) => void;
  onNotice: (message: string) => void;
}

export function PasskeyPanel({ onError, onNotice }: PasskeyPanelProps) {
  const query = useQuery((signal) => passkeyApi.list(signal), []);
  const [supported, setSupported] = useState<boolean | null>(null);
  const [platformAuthenticator, setPlatformAuthenticator] = useState<boolean | null>(null);
  const [adding, setAdding] = useState(false);
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirmRevokeAll, setConfirmRevokeAll] = useState(false);

  useEffect(() => {
    setSupported(isWebAuthnAvailable());
    void isPlatformAuthenticatorAvailable().then(setPlatformAuthenticator);
  }, []);

  const credentials: PasskeyCredentialSummary[] = useMemo(
    () => query.data?.credentials ?? [],
    [query.data],
  );
  const refresh = useCallback(() => {
    void query.refetch();
  }, [query]);

  async function addPasskey(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setBusy(true);
    try {
      const begun = await passkeyApi.beginRegistration(label.trim());
      const credential = (await navigator.credentials.create({
        publicKey: fromWebAuthnJSON(begun.options),
      })) as unknown;
      if (!credential) throw new Error('The authenticator returned no credential');

      await passkeyApi.finishRegistration({
        response: toWebAuthnJSON(credential),
        challengeId: begun.challengeId,
        label: label.trim(),
      });

      setLabel('');
      setAdding(false);
      onNotice('Passkey registered. You can now sign in with it.');
      refresh();
    } catch (error) {
      // Closing the platform sheet is a normal outcome, not a failure.
      if (isCredentialAborted(error)) {
        setAdding(false);
        return;
      }
      onError(error instanceof Error ? error.message : 'Could not register the passkey');
    } finally {
      setBusy(false);
    }
  }

  async function revoke(credential: PasskeyCredentialSummary): Promise<void> {
    setBusy(true);
    try {
      await passkeyApi.revoke(credential.id);
      onNotice(`Removed "${credential.label}".`);
      refresh();
    } catch (error) {
      onError(error instanceof Error ? error.message : 'Could not remove the passkey');
    } finally {
      setBusy(false);
    }
  }

  async function revokeAll(): Promise<void> {
    setBusy(true);
    try {
      await passkeyApi.revokeAll();
      setConfirmRevokeAll(false);
      onNotice('All passkeys removed.');
      refresh();
    } catch (error) {
      onError(error instanceof Error ? error.message : 'Could not remove the passkeys');
    } finally {
      setBusy(false);
    }
  }

  if (supported === false) {
    return (
      <section className="card card-pad stack" aria-label="Passkeys">
        <h2>Passkeys</h2>
        <EmptyState
          title="Not supported by this browser"
          description="Passkeys need a browser that implements WebAuthn. On a phone this means unlocking with Face ID, Touch ID or a fingerprint."
        />
      </section>
    );
  }

  return (
    <section className="card card-pad stack" aria-label="Passkeys">
      <header className="row-between">
        <h2>Passkeys</h2>
        {platformAuthenticator === true ? (
          <span className="subtle">This device can unlock with a biometric</span>
        ) : null}
      </header>

      <p className="subtle">
        A passkey signs you in with Face ID, Touch ID or a fingerprint instead of a
        password. The private key never leaves this device.
      </p>

      {query.isLoading && credentials.length === 0 ? <Spinner label="Loading passkeys" /> : null}

      {!query.isLoading && credentials.length === 0 ? (
        <EmptyState
          title="No passkeys yet"
          description="Add one to sign in without typing a password."
          action={supported ? { label: 'Add a passkey', onClick: () => setAdding(true) } : undefined}
        />
      ) : null}

      {credentials.length > 0 ? (
        <ul className="list-plain stack-sm">
          {credentials.map((credential) => (
            <li key={credential.id} className="row-between reference-row">
              <span className="stack-xs" style={{ minWidth: 0 }}>
                <span className="row gap-sm">
                  <strong>{credential.label || 'Unnamed passkey'}</strong>
                  <Badge tone={credential.attachment === 'platform' ? 'success' : 'info'}>
                    {credential.attachment === 'platform' ? 'This device' : 'Synced / roaming'}
                  </Badge>
                </span>
                <span className="subtle">{describeAttachment(credential)}</span>
                <span className="subtle">
                  Added {formatDate(credential.createdAt)}
                  {credential.lastUsedAt ? ` · last used ${formatDate(credential.lastUsedAt)}` : ''}
                </span>
              </span>
              <Button
                variant="ghost"
                size="sm"
                disabled={busy}
                onClick={() => void revoke(credential)}
                aria-label={`Remove passkey ${credential.label || credential.id}`}
              >
                Remove
              </Button>
            </li>
          ))}
        </ul>
      ) : null}

      <div className="row gap-xs">
        <Button size="sm" onClick={() => setAdding(true)} disabled={busy}>
          Add a passkey
        </Button>
        {credentials.length > 0 ? (
          <Button
            variant="ghost"
            size="sm"
            disabled={busy}
            onClick={() => setConfirmRevokeAll(true)}
          >
            Remove all
          </Button>
        ) : null}
      </div>

      {adding ? (
        <Modal open title="Add a passkey" onClose={() => setAdding(false)}>
          <form className="stack-sm" onSubmit={(event) => void addPasskey(event)}>
            <label htmlFor="passkey-label">Name this device</label>
            <input
              id="passkey-label"
              value={label}
              onChange={(event) => setLabel(event.target.value)}
              placeholder="e.g. Work iPhone"
              maxLength={120}
            />
            <p className="subtle">
              You will be asked to confirm with your device's biometric prompt. The
              private key is generated on the device and never reaches this server.
            </p>
            <div className="row gap-xs">
              <Button type="submit" disabled={busy}>
                {busy ? 'Waiting for your device…' : 'Continue'}
              </Button>
              <Button type="button" variant="ghost" onClick={() => setAdding(false)}>
                Cancel
              </Button>
            </div>
          </form>
        </Modal>
      ) : null}

      {confirmRevokeAll ? (
        <Modal open title="Remove all passkeys?" onClose={() => setConfirmRevokeAll(false)}>
          <div className="stack-sm">
            <p>
              You will not be able to sign in with a passkey afterwards. If this
              account has no password, you will be locked out.
            </p>
            <div className="row gap-xs">
              <Button variant="danger" disabled={busy} onClick={() => void revokeAll()}>
                Remove all passkeys
              </Button>
              <Button variant="ghost" onClick={() => setConfirmRevokeAll(false)}>
                Cancel
              </Button>
            </div>
          </div>
        </Modal>
      ) : null}
    </section>
  );
}

export default PasskeyPanel;
