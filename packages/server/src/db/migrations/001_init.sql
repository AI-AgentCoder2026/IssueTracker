-- ===========================================================================
-- 001_init.sql — core schema for the issue tracker.
--
-- Conventions
--   * All tables are STRICT so a wrong type fails loudly instead of coercing.
--   * Timestamps are ISO-8601 UTC strings produced by strftime('%Y-%m-%dT%H:%M:%fZ').
--   * Booleans are INTEGER 0/1; JSON is stored as TEXT holding valid JSON.
--   * Foreign keys are declared with an explicit ON DELETE behaviour so the
--     cascade rules are reviewable in one place.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- Identity
-- ---------------------------------------------------------------------------

CREATE TABLE users (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  username       TEXT    NOT NULL UNIQUE,
  email          TEXT    NOT NULL UNIQUE,
  display_name   TEXT    NOT NULL,
  avatar_url     TEXT,
  -- Argon2id encoded hash; NULL for SSO-only accounts.
  password_hash  TEXT,
  provider       TEXT    NOT NULL DEFAULT 'local',
  instance_role  TEXT    NOT NULL DEFAULT 'user',
  is_active      INTEGER NOT NULL DEFAULT 1,
  -- PII scrubbing is applied to fields captured here before they are stored.
  timezone       TEXT    NOT NULL DEFAULT 'UTC',
  locale         TEXT    NOT NULL DEFAULT 'en',
  email_opt_out  INTEGER NOT NULL DEFAULT 0,
  last_login_at  TEXT,
  created_at     TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at     TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK (instance_role IN ('user','staff','admin')),
  CHECK (provider IN ('local','saml','oidc','ldap','guest')),
  CHECK (is_active IN (0,1))
) STRICT;

CREATE INDEX idx_users_active ON users(is_active);
CREATE INDEX idx_users_email_ci ON users(lower(email));

-- Federated identity links, one row per (provider, external subject).
CREATE TABLE external_identities (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id           INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider          TEXT    NOT NULL,
  external_id       TEXT    NOT NULL,
  external_username TEXT,
  created_at        TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  last_login_at     TEXT,
  UNIQUE (provider, external_id)
) STRICT;

CREATE INDEX idx_external_identities_user ON external_identities(user_id);

-- Instance-level SSO/SAML configuration.
CREATE TABLE sso_configurations (
  id                      INTEGER PRIMARY KEY AUTOINCREMENT,
  name                    TEXT    NOT NULL,
  protocol                TEXT    NOT NULL CHECK (protocol IN ('saml','oidc')),
  enabled                 INTEGER NOT NULL DEFAULT 1,
  issuer                  TEXT,
  client_id               TEXT,
  -- Encrypted at rest with the instance key; never returned over the API.
  client_secret_encrypted TEXT,
  authorization_endpoint  TEXT,
  token_endpoint          TEXT,
  userinfo_endpoint       TEXT,
  jwks_uri                TEXT,
  entity_id               TEXT,
  sso_url                 TEXT,
  idp_certificate         TEXT,
  attribute_map           TEXT    NOT NULL DEFAULT '{}',
  allowed_domains         TEXT    NOT NULL DEFAULT '[]',
  auto_provision          INTEGER NOT NULL DEFAULT 0,
  default_role            TEXT    NOT NULL DEFAULT 'viewer',
  is_default              INTEGER NOT NULL DEFAULT 0,
  created_at              TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at              TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK (auto_provision IN (0,1)),
  CHECK (is_default IN (0,1))
) STRICT;

CREATE TABLE sessions (
  id           TEXT    PRIMARY KEY,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  ip_address   TEXT    NOT NULL DEFAULT '',
  user_agent   TEXT    NOT NULL DEFAULT '',
  expires_at   TEXT    NOT NULL,
  created_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  last_seen_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
) STRICT;

CREATE INDEX idx_sessions_user ON sessions(user_id);
CREATE INDEX idx_sessions_expiry ON sessions(expires_at);

-- Long-lived tokens for CI and bots. Only the hash is stored.
CREATE TABLE api_tokens (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name         TEXT    NOT NULL,
  prefix       TEXT    NOT NULL,
  token_hash   TEXT    NOT NULL UNIQUE,
  scopes       TEXT    NOT NULL DEFAULT '[]',
  project_ids  TEXT    NOT NULL DEFAULT '[]',
  expires_at   TEXT,
  last_used_at TEXT,
  revoked_at   TEXT,
  created_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
) STRICT;

CREATE INDEX idx_api_tokens_user ON api_tokens(user_id);

-- Time-bound guest access links.
CREATE TABLE guest_tokens (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id  INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  issue_id    INTEGER REFERENCES issues(id) ON DELETE CASCADE,
  label       TEXT    NOT NULL,
  token_hash  TEXT    NOT NULL UNIQUE,
  role        TEXT    NOT NULL DEFAULT 'viewer',
  can_comment INTEGER NOT NULL DEFAULT 0,
  expires_at  TEXT    NOT NULL,
  max_uses    INTEGER,
  use_count   INTEGER NOT NULL DEFAULT 0,
  revoked_at  TEXT,
  created_by  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK (can_comment IN (0,1)),
  CHECK (role IN ('viewer','reporter'))
) STRICT;

CREATE INDEX idx_guest_tokens_project ON guest_tokens(project_id);

-- ---------------------------------------------------------------------------
-- Projects, members, workflow
-- ---------------------------------------------------------------------------

CREATE TABLE projects (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  key                 TEXT    NOT NULL UNIQUE,
  name                TEXT    NOT NULL,
  description         TEXT    NOT NULL DEFAULT '',
  visibility          TEXT    NOT NULL DEFAULT 'private',
  default_issue_type  TEXT    NOT NULL DEFAULT 'task',
  default_priority    TEXT    NOT NULL DEFAULT 'medium',
  -- Next issue sequence value; incremented atomically on create.
  next_issue_number   INTEGER NOT NULL DEFAULT 1,
  -- Which side is canonical when a GitLab connection exists.
  source_of_truth     TEXT    NOT NULL DEFAULT 'local',
  archive_policy      TEXT,
  created_by          INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at          TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at          TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK (visibility IN ('private','internal','public')),
  CHECK (source_of_truth IN ('local','gitlab'))
) STRICT;

CREATE TABLE project_members (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role       TEXT    NOT NULL,
  created_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (project_id, user_id)
) STRICT;

CREATE INDEX idx_project_members_user ON project_members(user_id);

-- One workflow per project; projects customise their own status set.
CREATE TABLE workflows (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id  INTEGER NOT NULL UNIQUE REFERENCES projects(id) ON DELETE CASCADE,
  name        TEXT    NOT NULL DEFAULT 'Default',
  description TEXT    NOT NULL DEFAULT '',
  is_default  INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK (is_default IN (0,1))
) STRICT;

CREATE TABLE workflow_statuses (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  workflow_id   INTEGER NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  project_id    INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  key           TEXT    NOT NULL,
  name          TEXT    NOT NULL,
  state         TEXT    NOT NULL,
  category      TEXT    NOT NULL,
  color         TEXT    NOT NULL DEFAULT '#6b7280',
  description   TEXT    NOT NULL DEFAULT '',
  position      INTEGER NOT NULL DEFAULT 0,
  is_resolution INTEGER NOT NULL DEFAULT 0,
  is_closed     INTEGER NOT NULL DEFAULT 0,
  is_done       INTEGER NOT NULL DEFAULT 0,
  wip_limit     INTEGER,
  UNIQUE (workflow_id, key)
) STRICT;

CREATE INDEX idx_workflow_statuses_workflow ON workflow_statuses(workflow_id, position);
CREATE INDEX idx_workflow_statuses_project ON workflow_statuses(project_id);

-- from_status_id NULL means "allowed from any status".
CREATE TABLE workflow_transitions (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  workflow_id         INTEGER NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  from_status_id      INTEGER REFERENCES workflow_statuses(id) ON DELETE CASCADE,
  to_status_id        INTEGER NOT NULL REFERENCES workflow_statuses(id) ON DELETE CASCADE,
  name                TEXT    NOT NULL,
  description         TEXT    NOT NULL DEFAULT '',
  required_permission TEXT,
  created_at          TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
) STRICT;

CREATE INDEX idx_workflow_transitions_workflow ON workflow_transitions(workflow_id);
CREATE INDEX idx_workflow_transitions_from ON workflow_transitions(from_status_id);

-- ---------------------------------------------------------------------------
-- Labels & milestones
-- ---------------------------------------------------------------------------

CREATE TABLE labels (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  -- NULL project_id marks an instance-wide label available to every project.
  project_id  INTEGER REFERENCES projects(id) ON DELETE CASCADE,
  name        TEXT    NOT NULL,
  slug        TEXT    NOT NULL,
  color       TEXT    NOT NULL DEFAULT '#6b7280',
  description TEXT    NOT NULL DEFAULT '',
  created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
) STRICT;

-- COALESCE folds the NULL global scope onto 0 so uniqueness really holds.
CREATE UNIQUE INDEX idx_labels_scope_slug ON labels(COALESCE(project_id, 0), slug);
CREATE INDEX idx_labels_project ON labels(project_id);

CREATE TABLE milestones (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id  INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title       TEXT    NOT NULL,
  description TEXT    NOT NULL DEFAULT '',
  state       TEXT    NOT NULL DEFAULT 'planned',
  due_date    TEXT,
  start_date  TEXT,
  closed_at   TEXT,
  created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK (state IN ('planned','active','closed'))
) STRICT;

CREATE INDEX idx_milestones_project ON milestones(project_id, state);

-- ---------------------------------------------------------------------------
-- Issues
-- ---------------------------------------------------------------------------

CREATE TABLE issues (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id       INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  sequence         INTEGER NOT NULL,
  key              TEXT    NOT NULL UNIQUE,
  title            TEXT    NOT NULL,
  description      TEXT    NOT NULL DEFAULT '',
  type             TEXT    NOT NULL DEFAULT 'task',
  priority         TEXT    NOT NULL DEFAULT 'medium',
  state            TEXT    NOT NULL DEFAULT 'open',
  status_id        INTEGER NOT NULL REFERENCES workflow_statuses(id),
  assignee_id      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  reporter_id      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  -- Self-reference for sub-task nesting; cleared rather than cascading.
  parent_id        INTEGER REFERENCES issues(id) ON DELETE SET NULL,
  due_date         TEXT,
  started_at       TEXT,
  resolved_at      TEXT,
  closed_at        TEXT,
  estimate_hours   REAL,
  time_spent_hours REAL    NOT NULL DEFAULT 0,
  -- REAL so a card dropped between two rows can be ordered fractionally.
  position         REAL    NOT NULL DEFAULT 0,
  milestone_id     INTEGER REFERENCES milestones(id) ON DELETE SET NULL,
  archived         INTEGER NOT NULL DEFAULT 0,
  archived_at      TEXT,
  -- Bumped on every write; clients send it back for optimistic concurrency.
  version          INTEGER NOT NULL DEFAULT 1,
  created_at       TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at       TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (project_id, sequence),
  CHECK (archived IN (0,1))
) STRICT;

-- The board query: non-archived issues grouped by column for one project.
CREATE INDEX idx_issues_board ON issues(project_id, status_id, position);
CREATE INDEX idx_issues_state ON issues(project_id, state, archived);
CREATE INDEX idx_issues_assignee ON issues(assignee_id, state);
CREATE INDEX idx_issues_parent ON issues(parent_id);
CREATE INDEX idx_issues_updated ON issues(project_id, updated_at DESC);
CREATE INDEX idx_issues_due ON issues(due_date) WHERE due_date IS NOT NULL;
CREATE INDEX idx_issues_milestone ON issues(milestone_id);
CREATE INDEX idx_issues_type ON issues(project_id, type);
CREATE INDEX idx_issues_priority ON issues(project_id, priority);

CREATE TABLE issue_labels (
  issue_id  INTEGER NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  label_id  INTEGER NOT NULL REFERENCES labels(id) ON DELETE CASCADE,
  created_at TEXT   NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (issue_id, label_id)
) STRICT;

CREATE INDEX idx_issue_labels_label ON issue_labels(label_id);

-- Directed link. The reverse edge is derived, so a relation is stored once.
CREATE TABLE issue_links (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  source_issue_id INTEGER NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  target_issue_id INTEGER NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  kind           TEXT    NOT NULL,
  -- Set when created by duplicate detection rather than a human.
  auto_detected  INTEGER NOT NULL DEFAULT 0,
  confidence     REAL,
  created_by     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at     TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  -- Prevent a link in both directions, and self-links.
  CHECK (source_issue_id <> target_issue_id),
  UNIQUE (source_issue_id, target_issue_id, kind)
) STRICT;

CREATE INDEX idx_issue_links_source ON issue_links(source_issue_id);
CREATE INDEX idx_issue_links_target ON issue_links(target_issue_id);
CREATE INDEX idx_issue_links_auto ON issue_links(auto_detected) WHERE auto_detected = 1;

-- ---------------------------------------------------------------------------
-- Collaboration
-- ---------------------------------------------------------------------------

CREATE TABLE comments (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  issue_id      INTEGER NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  author_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  body          TEXT    NOT NULL,
  -- Automated messages (transitions, sync results) are marked so the UI can
  -- style them and so human authors can be filtered out.
  is_system     INTEGER NOT NULL DEFAULT 0,
  resolves_thread_id INTEGER REFERENCES comments(id) ON DELETE SET NULL,
  edited_at     TEXT,
  created_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK (is_system IN (0,1))
) STRICT;

CREATE INDEX idx_comments_issue ON comments(issue_id, created_at);
CREATE INDEX idx_comments_author ON comments(author_id);

-- Extracted @mentions drive notification fan-out.
CREATE TABLE comment_mentions (
  comment_id  INTEGER NOT NULL REFERENCES comments(id) ON DELETE CASCADE,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (comment_id, user_id)
) STRICT;

CREATE INDEX idx_comment_mentions_user ON comment_mentions(user_id);

CREATE TABLE attachments (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  issue_id     INTEGER NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  comment_id   INTEGER REFERENCES comments(id) ON DELETE CASCADE,
  filename     TEXT    NOT NULL,
  stored_name  TEXT    NOT NULL,
  mime_type    TEXT    NOT NULL,
  size_bytes   INTEGER NOT NULL,
  -- SHA-256 of the content, used to deduplicate identical uploads.
  checksum     TEXT    NOT NULL,
  uploaded_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
) STRICT;

CREATE INDEX idx_attachments_issue ON attachments(issue_id);
CREATE INDEX idx_attachments_checksum ON attachments(checksum);

CREATE TABLE watchers (
  issue_id  INTEGER NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  user_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT   NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (issue_id, user_id)
) STRICT;

CREATE INDEX idx_watchers_user ON watchers(user_id);

-- ---------------------------------------------------------------------------
-- Activity timeline
-- ---------------------------------------------------------------------------

-- Append-only. One row per meaningful change; drives the per-issue timeline and
-- the "recent activity" dashboard widget.
CREATE TABLE activity_events (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  issue_id           INTEGER NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  project_id         INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  actor_id           INTEGER REFERENCES users(id) ON DELETE SET NULL,
  type               TEXT    NOT NULL,
  summary            TEXT    NOT NULL,
  changes            TEXT    NOT NULL DEFAULT '[]',
  metadata           TEXT    NOT NULL DEFAULT '{}',
  is_system_generated INTEGER NOT NULL DEFAULT 0,
  created_at         TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK (is_system_generated IN (0,1))
) STRICT;

CREATE INDEX idx_activity_issue ON activity_events(issue_id, created_at);
CREATE INDEX idx_activity_project ON activity_events(project_id, created_at DESC);
CREATE INDEX idx_activity_actor ON activity_events(actor_id);

-- ---------------------------------------------------------------------------
-- Immutable audit trail
-- ---------------------------------------------------------------------------

-- Each row stores prev_hash (the previous row's row_hash) and row_hash, the
-- SHA-256 of its own canonical contents. Editing or deleting any row breaks
-- verification from that point onward, which is what makes the trail
-- tamper-evident. Triggers below refuse updates and deletes outright.
CREATE TABLE audit_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  actor_name  TEXT    NOT NULL DEFAULT '',
  actor_email TEXT    NOT NULL DEFAULT '',
  ip_address  TEXT    NOT NULL DEFAULT '',
  user_agent  TEXT    NOT NULL DEFAULT '',
  action      TEXT    NOT NULL,
  entity_type TEXT    NOT NULL,
  entity_id   TEXT,
  project_id  INTEGER REFERENCES projects(id) ON DELETE SET NULL,
  before_json TEXT,
  after_json  TEXT,
  row_hash    TEXT    NOT NULL,
  prev_hash   TEXT,
  created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
) STRICT;

CREATE INDEX idx_audit_created ON audit_log(created_at DESC);
CREATE INDEX idx_audit_actor ON audit_log(actor_id, created_at DESC);
CREATE INDEX idx_audit_action ON audit_log(action, created_at DESC);
CREATE INDEX idx_audit_entity ON audit_log(entity_type, entity_id);
CREATE INDEX idx_audit_project ON audit_log(project_id, created_at DESC);

-- Immutability guards. The application never needs to modify an audit row, so
-- any such statement is either a bug or tampering.
CREATE TRIGGER audit_log_no_update
BEFORE UPDATE ON audit_log
BEGIN
  SELECT RAISE(ABORT, 'audit_log is append-only: updates are not permitted');
END;

CREATE TRIGGER audit_log_no_delete
BEFORE DELETE ON audit_log
BEGIN
  SELECT RAISE(ABORT, 'audit_log is append-only: deletes are not permitted');
END;

-- ---------------------------------------------------------------------------
-- Notifications
-- ---------------------------------------------------------------------------

CREATE TABLE notifications (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event      TEXT    NOT NULL,
  issue_id   INTEGER REFERENCES issues(id) ON DELETE CASCADE,
  title      TEXT    NOT NULL,
  body       TEXT    NOT NULL DEFAULT '',
  payload    TEXT    NOT NULL DEFAULT '{}',
  read_at    TEXT,
  created_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
) STRICT;

CREATE INDEX idx_notifications_user ON notifications(user_id, read_at, created_at DESC);

CREATE TABLE notification_preferences (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event   TEXT    NOT NULL,
  in_app  INTEGER NOT NULL DEFAULT 1,
  email   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, event),
  CHECK (in_app IN (0,1)),
  CHECK (email IN (0,1))
) STRICT;

-- Durable email outbox so a failed SMTP connection retries rather than drops.
CREATE TABLE email_outbox (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  to_email    TEXT    NOT NULL,
  to_name     TEXT    NOT NULL DEFAULT '',
  subject     TEXT    NOT NULL,
  body_text   TEXT    NOT NULL,
  body_html   TEXT    NOT NULL DEFAULT '',
  status      TEXT    NOT NULL DEFAULT 'queued',
  attempts    INTEGER NOT NULL DEFAULT 0,
  last_error  TEXT,
  created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  sent_at     TEXT,
  CHECK (status IN ('queued','sent','failed'))
) STRICT;

CREATE INDEX idx_email_outbox_status ON email_outbox(status, created_at);

-- ---------------------------------------------------------------------------
-- Dashboards
-- ---------------------------------------------------------------------------

CREATE TABLE dashboards (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  -- NULL project_id marks an instance-wide dashboard template.
  project_id  INTEGER REFERENCES projects(id) ON DELETE CASCADE,
  name        TEXT    NOT NULL,
  description TEXT    NOT NULL DEFAULT '',
  -- JSON array of role names; empty means visible to all project members.
  roles       TEXT    NOT NULL DEFAULT '[]',
  is_default  INTEGER NOT NULL DEFAULT 0,
  created_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK (is_default IN (0,1))
) STRICT;

CREATE INDEX idx_dashboards_project ON dashboards(project_id);

CREATE TABLE dashboard_widgets (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  dashboard_id  INTEGER NOT NULL REFERENCES dashboards(id) ON DELETE CASCADE,
  type          TEXT    NOT NULL,
  title         TEXT    NOT NULL DEFAULT '',
  x             INTEGER NOT NULL DEFAULT 0,
  y             INTEGER NOT NULL DEFAULT 0,
  w             INTEGER NOT NULL DEFAULT 4,
  h             INTEGER NOT NULL DEFAULT 3,
  filters       TEXT    NOT NULL DEFAULT '{}',
  limit_value   INTEGER NOT NULL DEFAULT 10,
  hidden_from_roles TEXT NOT NULL DEFAULT '[]'
) STRICT;

CREATE INDEX idx_dashboard_widgets_dashboard ON dashboard_widgets(dashboard_id, y, x);

-- ---------------------------------------------------------------------------
-- SLA
-- ---------------------------------------------------------------------------

CREATE TABLE sla_policies (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  -- NULL project_id marks an instance-wide default policy.
  project_id           INTEGER REFERENCES projects(id) ON DELETE CASCADE,
  name                 TEXT    NOT NULL,
  description          TEXT    NOT NULL DEFAULT '',
  applies_to           TEXT    NOT NULL DEFAULT '{}',
  response_minutes     INTEGER,
  resolution_minutes   INTEGER,
  warning_minutes      INTEGER NOT NULL DEFAULT 60,
  business_hours_only  INTEGER NOT NULL DEFAULT 0,
  enabled              INTEGER NOT NULL DEFAULT 1,
  created_at           TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at           TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK (enabled IN (0,1)),
  CHECK (business_hours_only IN (0,1))
) STRICT;

CREATE INDEX idx_sla_policies_project ON sla_policies(project_id, enabled);

-- One row per (issue, policy, target) with the live countdown state.
CREATE TABLE sla_clocks (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  policy_id     INTEGER NOT NULL REFERENCES sla_policies(id) ON DELETE CASCADE,
  issue_id      INTEGER NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  target        TEXT    NOT NULL,
  starts_at     TEXT    NOT NULL,
  due_at        TEXT,
  met_at        TEXT,
  -- Notified once when the clock enters the warning window.
  warned_at     TEXT,
  breach_notified_at TEXT,
  UNIQUE (policy_id, issue_id, target),
  CHECK (target IN ('response','resolution'))
) STRICT;

CREATE INDEX idx_sla_clocks_due ON sla_clocks(due_at) WHERE due_at IS NOT NULL;
CREATE INDEX idx_sla_clocks_issue ON sla_clocks(issue_id);

-- ---------------------------------------------------------------------------
-- GitLab integration
-- ---------------------------------------------------------------------------

CREATE TABLE gitlab_connections (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id            INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  base_url              TEXT    NOT NULL,
  gitlab_project_path   TEXT    NOT NULL,
  -- Encrypted at rest with the instance key; never leaves the server.
  access_token_encrypted TEXT   NOT NULL,
  -- Decides which side wins a conflict. See SYNC_MODES in @tracker/shared.
  sync_mode             TEXT    NOT NULL DEFAULT 'bidirectional',
  enabled               INTEGER NOT NULL DEFAULT 1,
  sync_hierarchy        INTEGER NOT NULL DEFAULT 1,
  sync_comments         INTEGER NOT NULL DEFAULT 1,
  sync_labels           INTEGER NOT NULL DEFAULT 1,
  sync_incidents        INTEGER NOT NULL DEFAULT 0,
  title_prefix          TEXT    NOT NULL DEFAULT '',
  last_sync_at          TEXT,
  last_sync_status      TEXT    NOT NULL DEFAULT 'never',
  last_sync_error       TEXT,
  -- Webhook secret used to verify inbound GitLab event signatures.
  webhook_secret        TEXT,
  created_at            TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at            TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (base_url, gitlab_project_path),
  CHECK (sync_mode IN ('local_authoritative','gitlab_authoritative','bidirectional')),
  CHECK (enabled IN (0,1))
) STRICT;

CREATE INDEX idx_gitlab_connections_project ON gitlab_connections(project_id);

-- Provenance for each mirrored issue, so a later sync can tell an imported
-- field from a locally edited one and resolve conflicts correctly.
CREATE TABLE gitlab_external_links (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  connection_id     INTEGER NOT NULL REFERENCES gitlab_connections(id) ON DELETE CASCADE,
  issue_id          INTEGER NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  external_id       TEXT    NOT NULL,
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

CREATE INDEX idx_gitlab_links_sync_state ON gitlab_external_links(connection_id, sync_state);
CREATE INDEX idx_gitlab_links_issue ON gitlab_external_links(issue_id);

CREATE TABLE gitlab_sync_runs (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  connection_id INTEGER NOT NULL REFERENCES gitlab_connections(id) ON DELETE CASCADE,
  direction     TEXT    NOT NULL,
  trigger       TEXT    NOT NULL,
  status        TEXT    NOT NULL DEFAULT 'running',
  pushed        INTEGER NOT NULL DEFAULT 0,
  pulled        INTEGER NOT NULL DEFAULT 0,
  conflicts     INTEGER NOT NULL DEFAULT 0,
  failed        INTEGER NOT NULL DEFAULT 0,
  message       TEXT,
  started_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  finished_at   TEXT,
  CHECK (direction IN ('push','pull','full')),
  CHECK (trigger IN ('manual','webhook','schedule','issue_change')),
  CHECK (status IN ('running','ok','error'))
) STRICT;

CREATE INDEX idx_gitlab_sync_runs_connection ON gitlab_sync_runs(connection_id, started_at DESC);

-- A recorded disagreement. Surfaced in the UI for explicit resolution so a
-- bidirectional sync never silently discards work.
CREATE TABLE gitlab_sync_conflicts (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  connection_id     INTEGER NOT NULL REFERENCES gitlab_connections(id) ON DELETE CASCADE,
  issue_id          INTEGER NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  local_issue_key   TEXT    NOT NULL,
  field             TEXT    NOT NULL,
  local_value       TEXT,
  gitlab_value      TEXT,
  local_updated_at  TEXT    NOT NULL,
  gitlab_updated_at TEXT    NOT NULL,
  resolved_at       TEXT,
  resolution        TEXT,
  created_at        TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (connection_id, issue_id, field),
  CHECK (resolution IS NULL OR resolution IN ('kept_local','kept_gitlab','merged'))
) STRICT;

CREATE INDEX idx_gitlab_conflicts_unresolved ON gitlab_sync_conflicts(connection_id)
  WHERE resolved_at IS NULL;

-- ---------------------------------------------------------------------------
-- Outgoing webhooks
-- ---------------------------------------------------------------------------

CREATE TABLE webhooks (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id  INTEGER REFERENCES projects(id) ON DELETE CASCADE,
  name        TEXT    NOT NULL,
  target_url  TEXT    NOT NULL,
  secret      TEXT    NOT NULL,
  events      TEXT    NOT NULL DEFAULT '[]',
  enabled     INTEGER NOT NULL DEFAULT 1,
  -- Backoff schedule after repeated failures.
  failure_count INTEGER NOT NULL DEFAULT 0,
  disabled_at TEXT,
  created_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK (enabled IN (0,1))
) STRICT;

CREATE INDEX idx_webhooks_project ON webhooks(project_id, enabled);

CREATE TABLE webhook_deliveries (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  webhook_id   INTEGER NOT NULL REFERENCES webhooks(id) ON DELETE CASCADE,
  event        TEXT    NOT NULL,
  payload      TEXT    NOT NULL,
  status_code  INTEGER,
  response_body TEXT,
  attempt      INTEGER NOT NULL DEFAULT 1,
  status       TEXT    NOT NULL DEFAULT 'pending',
  error        TEXT,
  -- Signatures in transit.
  request_signature TEXT,
  duration_ms  INTEGER,
  created_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  completed_at TEXT,
  CHECK (status IN ('pending','delivered','failed'))
) STRICT;

CREATE INDEX idx_webhook_deliveries_webhook ON webhook_deliveries(webhook_id, created_at DESC);
CREATE INDEX idx_webhook_deliveries_status ON webhook_deliveries(status, created_at);

-- De-duplicates inbound webhook deliveries, which GitLab may retry.
CREATE TABLE webhook_receipts (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  provider    TEXT    NOT NULL,
  event_id    TEXT    NOT NULL,
  event       TEXT,
  payload     TEXT    NOT NULL,
  received_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  processed_at TEXT,
  UNIQUE (provider, event_id)
) STRICT;

-- ---------------------------------------------------------------------------
-- Full-text search
-- ---------------------------------------------------------------------------

-- A standalone FTS5 index (not external-content) so the comment service can
-- append comment text without rewriting issue rows. Maintained by triggers for
-- title/description and explicitly by the comment service.
CREATE VIRTUAL TABLE issue_search USING fts5(
  title,
  description,
  key,
  tokenize = 'unicode61 remove_diacritics 2'
);

CREATE TRIGGER issues_fts_insert AFTER INSERT ON issues
BEGIN
  INSERT INTO issue_search(rowid, title, description, key)
  VALUES (new.id, new.title, new.description, new.key);
END;

CREATE TRIGGER issues_fts_delete AFTER DELETE ON issues
BEGIN
  DELETE FROM issue_search WHERE rowid = old.id;
END;

CREATE TRIGGER issues_fts_update AFTER UPDATE OF title, description, key ON issues
BEGIN
  DELETE FROM issue_search WHERE rowid = old.id;
  INSERT INTO issue_search(rowid, title, description, key)
  VALUES (new.id, new.title, new.description, new.key);
END;

-- Comments get their own index; the search service unions the two result sets.
CREATE VIRTUAL TABLE comment_search USING fts5(
  body,
  tokenize = 'unicode61 remove_diacritics 2'
);

CREATE TRIGGER comments_fts_insert AFTER INSERT ON comments
WHEN new.is_system = 0
BEGIN
  INSERT INTO comment_search(rowid, body) VALUES (new.id, new.body);
END;

CREATE TRIGGER comments_fts_delete AFTER DELETE ON comments
BEGIN
  DELETE FROM comment_search WHERE rowid = old.id;
END;

CREATE TRIGGER comments_fts_update AFTER UPDATE OF body ON comments
WHEN new.is_system = 0
BEGIN
  DELETE FROM comment_search WHERE rowid = old.id;
  INSERT INTO comment_search(rowid, body) VALUES (new.id, new.body);
END;

-- Comments that were system messages but are no longer still need purging.
CREATE TRIGGER comments_fts_system AFTER UPDATE OF is_system ON comments
WHEN new.is_system = 1
BEGIN
  DELETE FROM comment_search WHERE rowid = new.id;
END;
