/**
 * Profile summary for the account page.
 *
 * Small enough to stay in one component: it shows who you are and how to change
 * your display name. The password change lives in the API client already, so it
 * is wired here rather than duplicated.
 */

import { useCallback, useState } from 'react';
import { useAuth } from '../auth/AuthContext';
import { authApi } from '../api/repo';
import { useQuery } from '../api/hooks';
import { Button } from './Button';
import { Spinner } from './Spinner';

interface ProfileCardProps {
  onError: (message: string) => void;
  onNotice: (message: string) => void;
}

export function ProfileCard({ onError, onNotice }: ProfileCardProps) {
  const { user } = useAuth();
  // `authApi.me` takes no abort signal, so it is fetched once on mount.
  const query = useQuery(() => authApi.me(), []);
  const [displayName, setDisplayName] = useState('');
  const [busy, setBusy] = useState(false);

  const me = query.data ?? user;
  const name = displayName || (me?.displayName ?? '');

  const save = useCallback(async () => {
    if (displayName.trim().length === 0) {
      onError('A display name cannot be empty');
      return;
    }
    setBusy(true);
    try {
      await authApi.updateProfile({ displayName: displayName.trim() });
      setDisplayName('');
      onNotice('Profile updated');
      void query.refetch();
    } catch (error) {
      onError(error instanceof Error ? error.message : 'Could not update your profile');
    } finally {
      setBusy(false);
    }
  }, [displayName, onError, onNotice, query]);

  if (query.isLoading && !me) return <Spinner label="Loading your profile" />;

  return (
    <section className="card card-pad stack" aria-label="Profile">
      <h2>Profile</h2>
      <dl className="detail-list">
        <div>
          <dt>Username</dt>
          <dd>{me?.username ?? '—'}</dd>
        </div>
        <div>
          <dt>Email</dt>
          <dd>{me?.email ?? '—'}</dd>
        </div>
      </dl>

      <div className="row gap-xs" style={{ alignItems: 'flex-end' }}>
        <div className="grow">
          <label className="label" htmlFor="profile-display-name">
            Display name
          </label>
          <input
            id="profile-display-name"
            className="input"
            defaultValue={me?.displayName ?? ''}
            key={`${me?.id ?? 'none'}-${me?.displayName ?? ''}`}
            onChange={(event) => setDisplayName(event.target.value)}
            placeholder={name}
          />
        </div>
        <Button size="sm" onClick={() => void save()} disabled={busy || displayName.trim().length === 0}>
          Save
        </Button>
      </div>
    </section>
  );
}

export default ProfileCard;
