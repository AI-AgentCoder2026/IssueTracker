-- ===========================================================================
-- 002_version_control_linkage.sql
--
-- Links issues to real version-control artefacts.
--
-- Two levels, because they answer different questions:
--   project_repositories  which repository does this project live in?
--   issue_references      which branch / commit / merge request belongs to
--                         this specific issue?
--
-- The second table is deliberately not a branch-name convention on `issues`:
-- an issue usually needs several references (a feature branch, the commits on
-- it, the merge request, the deploy tag), and each of those can be updated
-- independently by GitLab as work progresses.
-- ===========================================================================

-- A repository a project is developed against.
CREATE TABLE project_repositories (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id        INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  provider          TEXT    NOT NULL DEFAULT 'gitlab',
  -- Human-facing name, e.g. `platform/api-gateway`.
  name              TEXT    NOT NULL,
  -- Base URL of the remote, for building links.
  base_url          TEXT    NOT NULL DEFAULT '',
  -- Numeric or namespaced identifier on the provider, when known.
  external_id       TEXT,
  -- Branch the project treats as its trunk.
  default_branch    TEXT    NOT NULL DEFAULT 'main',
  -- The `gitlab_connections` row this repository mirrors, when there is one.
  gitlab_connection_id INTEGER REFERENCES gitlab_connections(id) ON DELETE SET NULL,
  created_at        TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at        TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (project_id, provider, name),
  CHECK (provider IN ('gitlab', 'github', 'bitbucket', 'generic'))
) STRICT;

CREATE INDEX idx_project_repositories_project ON project_repositories(project_id);

-- A single VCS artefact attached to an issue.
CREATE TABLE issue_references (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  issue_id      INTEGER NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  repository_id INTEGER NOT NULL REFERENCES project_repositories(id) ON DELETE CASCADE,
  kind          TEXT    NOT NULL,
  provider      TEXT    NOT NULL DEFAULT 'gitlab',
  -- Commit SHA, merge-request iid, or branch name depending on `kind`.
  ref           TEXT    NOT NULL,
  -- Commit SHA for a branch; the MR head sha, for a merge request.
  head_sha      TEXT,
  title         TEXT    NOT NULL DEFAULT '',
  -- Provider-specific lifecycle state: `open`, `merged`, `closed`, `deployed`.
  state         TEXT    NOT NULL DEFAULT 'open',
  url           TEXT,
  -- Set when a human linked this, cleared when a sync inferred it.
  auto_detected INTEGER NOT NULL DEFAULT 0,
  -- Who linked it, and when; both retained for the timeline.
  linked_by     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  -- A branch cannot be linked to two issues, and the same artefact is not
  -- attached twice. NULL url participates in uniqueness like any other value.
  UNIQUE (repository_id, kind, ref),
  CHECK (kind IN ('branch', 'commit', 'merge_request', 'pull_request', 'tag', 'file')),
  CHECK (state IN ('open', 'merged', 'closed', 'deployed')),
  CHECK (auto_detected IN (0,1))
) STRICT;

CREATE INDEX idx_issue_references_issue ON issue_references(issue_id, kind);
CREATE INDEX idx_issue_references_repo ON issue_references(repository_id, kind);
CREATE INDEX idx_issue_references_auto ON issue_references(issue_id) WHERE auto_detected = 1;

-- ---------------------------------------------------------------------------
-- Auto-link branches by name convention.
--
-- GitLab (and most hosts) expose nothing that links a branch back to an issue,
-- so the conventional approach is a branch named `PROJ-123-add-login`. This
-- table makes the prefix configurable per project instead of hard-coding it,
-- and records what has been imported so a re-sync is idempotent.
-- ---------------------------------------------------------------------------

CREATE TABLE branch_link_rules (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id  INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  repository_id INTEGER NOT NULL REFERENCES project_repositories(id) ON DELETE CASCADE,
  -- Capture group naming the issue key, e.g. `^(?P<key>[A-Z]+-\d+)`.
  pattern     TEXT    NOT NULL,
  -- Prefix a human may add, e.g. `feature/`, that is stripped before matching.
  strip_prefixes TEXT  NOT NULL DEFAULT '[]',
  enabled     INTEGER NOT NULL DEFAULT 1,
  last_imported_at TEXT,
  created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK (enabled IN (0,1))
) STRICT;

CREATE INDEX idx_branch_link_rules_project ON branch_link_rules(project_id);
