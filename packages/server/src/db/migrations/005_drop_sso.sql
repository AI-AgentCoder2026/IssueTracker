-- ===========================================================================
-- 005_drop_sso.sql
--
-- Remove single sign-on.
--
-- The OIDC and SAML verification code was complete and its assertions were
-- verified before any claim was read, but a configuration could only be
-- listed, never created, edited or deleted — at the route layer and at the
-- service layer alike. A deployment therefore had to insert rows into
-- `sso_configurations` by hand, which makes the feature unusable in
-- practice. Shipping a half-reachable feature is worse than not shipping it,
-- so it is removed rather than left as a documented gap.
--
-- Both tables are leaves: nothing references `sso_configurations`, and
-- `external_identities` is only read by the SSO callback path. Dropping them
-- is safe. `001_init.sql` is left untouched because applied migrations are
-- checksummed, so editing it would break every existing database.
-- ===========================================================================

DROP INDEX IF EXISTS idx_external_identities_user;
DROP TABLE IF EXISTS external_identities;
DROP TABLE IF EXISTS sso_configurations;
