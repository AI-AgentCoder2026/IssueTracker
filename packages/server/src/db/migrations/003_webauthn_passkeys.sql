-- ===========================================================================
-- 003_webauthn_passkeys.sql
--
-- Passkey / biometric credentials.
--
-- A passkey is the browser-native equivalent of "biometric login": on a phone
-- the user approves with Face ID, Touch ID or a fingerprint, and the private
-- key never leaves the device's secure element. What the server stores is the
-- public key plus the counter that detects a cloned authenticator.
--
-- One table, deliberately: a credential belongs to a user, carries its own
-- label so several devices can be told apart, and is revoked rather than
-- deleted so its audit trail survives.
-- ===========================================================================

CREATE TABLE webauthn_credentials (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id           INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- Base64url credential id as issued by the authenticator. Unique per
  -- authenticator, not per user: the same passkey can serve several accounts.
  credential_id     TEXT    NOT NULL UNIQUE,
  -- Base64url of the COSE public key (ES256 / RS256 / EdDSA).
  public_key        TEXT    NOT NULL,
  counter           INTEGER NOT NULL DEFAULT 0,
  -- RP ID hash is implicit in the relying party configuration, but the
  -- transports tell the UI whether a device can be used for hybrid sign-in.
  transports        TEXT    NOT NULL DEFAULT '[]',
  -- What the user calls this device, e.g. "iPhone".
  label             TEXT    NOT NULL DEFAULT '',
  -- 'single' for a platform authenticator (biometric unlock), 'multi' for a
  -- roaming security key. Surfaced in the UI so the risk is legible.
  authenticator_attachment TEXT NOT NULL DEFAULT 'single',
  -- AAGUID, useful when diagnosing which authenticator was used.
  aaguid            TEXT,
  -- Backup eligibility: a synced passkey is a convenience, not a secret.
  backup_eligible   INTEGER NOT NULL DEFAULT 0,
  backup_state      INTEGER NOT NULL DEFAULT 0,
  -- Last successful assertion, for "this device was used 2h ago".
  last_used_at      TEXT,
  created_at        TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  revoked_at        TEXT,
  CHECK (transports IS NOT NULL),
  CHECK (authenticator_attachment IN ('platform', 'cross-platform')),
  CHECK (backup_eligible IN (0,1)),
  CHECK (backup_state IN (0,1))
) STRICT;

CREATE INDEX idx_webauthn_credentials_user ON webauthn_credentials(user_id) WHERE revoked_at IS NULL;
CREATE INDEX idx_webauthn_credentials_revoked ON webauthn_credentials(user_id, revoked_at);

-- Challenges must be single-use and short-lived. Kept server-side rather than
-- in the signed state so a challenge is consumed exactly once even if the state
-- is replayed within its window.
CREATE TABLE webauthn_challenges (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  -- 'registration' or 'authentication'.
  purpose        TEXT    NOT NULL,
  challenge      TEXT    NOT NULL UNIQUE,
  user_id        INTEGER REFERENCES users(id) ON DELETE CASCADE,
  -- Free-form context carried through the ceremony (for example the return
  -- path after a passkey login).
  context        TEXT    NOT NULL DEFAULT '{}',
  expires_at     TEXT    NOT NULL,
  consumed_at    TEXT,
  created_at     TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK (purpose IN ('registration','authentication'))
) STRICT;

CREATE INDEX idx_webauthn_challenges_expiry ON webauthn_challenges(expires_at) WHERE consumed_at IS NULL;
