-- ===========================================================================
-- 004_gitlab_pending_links.sql
--
-- Allow several issues to be "waiting to be created" on the remote.
--
-- `external_id` was NOT NULL, so the only way to represent an issue that has no
-- remote object yet was the empty string. Combined with
-- `UNIQUE (connection_id, external_id)` that permitted exactly ONE such row per
-- connection, so a second new local issue could not even be recorded.
--
-- SQLite treats NULLs as distinct in a UNIQUE constraint, which is precisely
-- the semantics wanted: many pending links, each still unique by issue.
--
-- SQLite cannot drop a UNIQUE constraint in place, so the table is rebuilt.
-- The old table is a leaf (nothing references it), so dropping is safe.
-- ===========================================================================

CREATE TABLE gitlab_external_links_migrated (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  connection_id     INTEGER NOT NULL REFERENCES gitlab_connections(id) ON DELETE CASCADE,
  issue_id          INTEGER NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  -- NULL until the remote object exists. See the header note.
  external_id       TEXT,
  external_key      TEXT,
  external_url      TEXT,
  -- Hash of the payload last pushed, used to skip no-op writes.
  last_pushed_hash  TEXT,
  last_pulled_at    TEXT,
  last_pushed_at    TEXT,
  remote_updated_at TEXT,
  sync_state        TEXT    NOT NULL DEFAULT 'synced',
  last_error        TEXT,
  created_at        TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (connection_id, external_id),
  UNIQUE (connection_id, issue_id),
  CHECK (sync_state IN ('synced','pending_push','pending_pull','conflict','local_only','gitlab_only','error'))
) STRICT;

-- Any existing empty string was the "not created yet" placeholder.
INSERT INTO gitlab_external_links_migrated
  (id, connection_id, issue_id, external_id, external_key, external_url,
   last_pushed_hash, last_pulled_at, last_pushed_at, remote_updated_at,
   sync_state, last_error, created_at)
SELECT
  id, connection_id, issue_id, NULLIF(external_id, ''), external_key, external_url,
  last_pushed_hash, last_pulled_at, last_pushed_at, remote_updated_at,
  sync_state, last_error, created_at
FROM gitlab_external_links;

DROP TABLE gitlab_external_links;

ALTER TABLE gitlab_external_links_migrated RENAME TO gitlab_external_links;

CREATE INDEX idx_gitlab_links_sync_state ON gitlab_external_links(connection_id, sync_state);
CREATE INDEX idx_gitlab_links_issue ON gitlab_external_links(issue_id);
CREATE INDEX idx_gitlab_links_auto ON gitlab_external_links(issue_id) WHERE sync_state = 'local_only';
