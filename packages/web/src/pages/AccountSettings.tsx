/**
 * Account settings.
 *
 * Deliberately outside the project layout: a passkey belongs to the *user*, so
 * it must not sit behind a project switcher where someone could register a
 * device while looking at the wrong project and be confused about which account
 * it applies to.
 */

import { PasskeyPanel } from '../components/PasskeyPanel';
import { ProfileCard } from '../components/ProfileCard';
import { useToast } from '../components/Toast';

export function AccountSettings(): JSX.Element {
  const toast = useToast();

  return (
    <div className="page stack" style={{ maxWidth: 720, margin: '0 auto' }}>
      <div className="page-header">
        <div className="page-title-group">
          <h1>Account</h1>
          <p className="page-subtitle">
            How you sign in. These settings apply to every project you can see.
          </p>
        </div>
      </div>

      <ProfileCard
        onError={(message) => toast.error(message)}
        onNotice={(message) => toast.success(message)}
      />

      <PasskeyPanel
        onError={(message) => toast.error(message)}
        onNotice={(message) => toast.success(message)}
      />
    </div>
  );
}

export default AccountSettings;
