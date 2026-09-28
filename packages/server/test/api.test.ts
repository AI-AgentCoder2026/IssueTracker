/**
 * End-to-end tests against a real Fastify instance.
 *
 * This is the integration net: it boots the whole app (every route plugin, the
 * WebSocket gateway, the service registry) and drives it over HTTP, so route
 * collisions, broken plugin wiring and contract mismatches surface here rather
 * than at deploy time.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { API } from '@tracker/shared';
import { buildApp, type TrackerApp } from '../src/app.ts';
import { Database } from '../src/db/connection.ts';
import { migrate } from '../src/db/migrate.ts';

let tracker: TrackerApp;
let baseUrl: string;
let sessionCookie = '';
let csrfCookie = '';
let adminId = 0;
let projectId = 0;

/** Perform a request with the session cookie attached. */
async function call(
  method: string,
  path: string,
  options: { body?: unknown; headers?: Record<string, string>; auth?: boolean } = {},
): Promise<{ status: number; body: any; headers: Headers }> {
  const headers: Record<string, string> = { ...options.headers };
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  if (options.auth !== false && sessionCookie) headers['cookie'] = sessionCookie;

  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });

  const text = await response.text();
  let body: unknown = text;
  try {
    body = text.length > 0 ? JSON.parse(text) : null;
  } catch {
    // Non-JSON response (e.g. the SPA shell); keep the raw text.
  }

  // Track the session cookie for subsequent calls.
  const setCookie = response.headers.getSetCookie?.() ?? [];
  for (const cookie of setCookie) {
    if (cookie.startsWith('tracker_session=')) {
      sessionCookie = cookie.split(';')[0] as string;
    }
    if (cookie.startsWith('tracker_csrf=')) {
      csrfCookie = cookie.split(';')[0] as string;
    }
  }

  return { status: response.status, body, headers: response.headers };
}

const get = (path: string) => call('GET', path);
const post = (path: string, body?: unknown) => call('POST', path, { body });
const patch = (path: string, body?: unknown) => call('PATCH', path, { body });

before(async () => {
  const db = new Database({ file: ':memory:', wal: false });
  migrate(db);

  tracker = await buildApp({
    db,
    config: {
      env: 'test',
      logLevel: 'silent',
      enableScheduler: false,
      serveWebClient: false,
      dataDir: process.env['TEMP'] ?? '/tmp',
      databaseFile: ':memory:',
    },
  });

  await tracker.app.ready();
  baseUrl = await tracker.app.listen({ host: '127.0.0.1', port: 0 });

  // Register the first user; they become the instance administrator.
  const registered = await post('/api/auth/register', {
    username: 'root',
    email: 'root@example.com',
    displayName: 'Root User',
    password: 'Sup3rSecret!Pass',
  });
  assert.equal(registered.status, 200, `register failed: ${JSON.stringify(registered.body)}`);
  adminId = registered.body.user.id;

  const login = await post('/api/auth/login', {
    login: 'root',
    password: 'Sup3rSecret!Pass',
  });
  assert.equal(login.status, 200, 'login failed');
  assert.ok(sessionCookie, 'login must set a session cookie');

  const created = await post('/api/projects', {
    key: 'E2E',
    name: 'End to end',
    description: '',
    visibility: 'private',
    defaultIssueType: 'task',
    defaultPriority: 'medium',
    archivePolicy: null,
  });
  assert.equal(created.status, 200, `project create failed: ${JSON.stringify(created.body)}`);
  projectId = created.body.project.id;
});

after(async () => {
  if (tracker) await tracker.close();
});

describe('application boot', () => {
  it('serves a health check without authentication', async () => {
    const response = await get('/api/health');
    assert.equal(response.status, 200);
    assert.equal(response.body.status, 'ok');
  });

  it('returns the shared error envelope for an unknown route', async () => {
    const response = await get('/api/definitely-not-a-route');
    assert.equal(response.status, 404);
    assert.equal(response.body.error.code, 'not_found');
  });
});

describe('authentication', () => {
  it('rejects an unauthenticated request to a protected route', async () => {
    const saved = sessionCookie;
    sessionCookie = '';
    try {
      const response = await get('/api/projects');
      assert.equal(response.status, 401);
      assert.equal(response.body.error.code, 'unauthenticated');
    } finally {
      sessionCookie = saved;
    }
  });

  it('rejects a wrong password without revealing which part was wrong', async () => {
    const response = await call('POST', '/api/auth/login', {
      body: { login: 'root', password: 'WrongPassword!1' },
      auth: false,
    });
    assert.equal(response.status, 401);
    assert.equal(response.body.error.message, 'Invalid credentials');
  });

  it('returns the current user for a valid session', async () => {
    const response = await get('/api/auth/me');
    assert.equal(response.status, 200);
    assert.equal(response.body.user.username, 'root');
    assert.equal(response.body.user.isInstanceAdmin, true);
  });

  it('never returns the password hash', async () => {
    const response = await get('/api/auth/me');
    assert.equal(response.body.user.passwordHash, undefined);
  });

  it('issues and revokes an API token', async () => {
    const created = await post('/api/users/me/tokens', { name: 'ci', scopes: [] });
    // 201 Created is correct for a new token.
    assert.equal(created.status, 201, JSON.stringify(created.body));
    // The response carries the record and the one-time plaintext side by side.
    assert.ok(created.body.secret, 'the plaintext secret is returned exactly once');
    assert.ok(created.body.token.prefix, 'a prefix is kept so the token can be identified');

    const listed = await get('/api/users/me/tokens');
    const tokens = listed.body.tokens ?? listed.body.apiTokens ?? listed.body;
    assert.ok(Array.isArray(tokens), `expected a token list, got ${JSON.stringify(listed.body)}`);
    assert.ok(tokens.every((t: any) => t.tokenHash === undefined), 'the hash never leaves the server');
    assert.ok(tokens.every((t: any) => t.secret === undefined), 'the secret is not re-served');

    const revoked = await call('DELETE', `/api/users/me/tokens/${created.body.token.id}`);
    assert.ok(revoked.status === 200 || revoked.status === 204, `revoke returned ${revoked.status}`);
  });
});

describe('projects and workflow', () => {
  it('lists the projects the actor can see', async () => {
    const response = await get('/api/projects');
    assert.equal(response.status, 200);
    assert.ok(response.body.projects.some((p: any) => p.id === projectId));
  });

  it('provisions a default workflow for a new project', async () => {
    const response = await get(`/api/projects/${projectId}/workflow`);
    assert.equal(response.status, 200);
    const keys = response.body.workflow.statuses.map((s: any) => s.key);
    for (const expected of ['open', 'in_progress', 'closed']) {
      assert.ok(keys.includes(expected), `expected a "${expected}" status`);
    }
    assert.equal(response.body.isUsingDefaults, true);
  });

  it('rejects a duplicate project key with a conflict', async () => {
    const response = await post('/api/projects', {
      key: 'E2E',
      name: 'Duplicate',
      description: '',
      visibility: 'private',
      defaultIssueType: 'task',
      defaultPriority: 'medium',
      archivePolicy: null,
    });
    assert.equal(response.status, 409);
    assert.equal(response.body.error.code, 'conflict');
  });

  it('validates the request body with field-level errors', async () => {
    const response = await post('/api/issues', { title: '', projectId });
    assert.equal(response.status, 422);
    assert.equal(response.body.error.code, 'validation_failed');
    assert.ok(Array.isArray(response.body.error.fields));
  });
});

describe('issue lifecycle over HTTP', () => {
  let issueId = 0;
  let issueKey = '';

  it('creates an issue', async () => {
    const response = await post('/api/issues', {
      projectId,
      title: 'E2E created issue',
      description: 'created by the end-to-end test',
      type: 'bug',
      priority: 'high',
    });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.ok(response.body.issue.id);
    assert.match(response.body.issue.key, /^E2E-\d+$/);
    issueId = response.body.issue.id;
    issueKey = response.body.issue.key;
  });

  it('reads the issue with its timing block', async () => {
    const response = await get(`/api/issues/${issueId}`);
    assert.equal(response.status, 200);
    assert.equal(response.body.issue.id, issueId);
    assert.ok(response.body.timing, 'the detail response includes a timing block');
    assert.ok(Array.isArray(response.body.links));
  });

  it('updates the issue and bumps its version', async () => {
    const response = await patch(`/api/issues/${issueId}`, { title: 'E2E renamed issue' });
    assert.equal(response.status, 200);
    assert.equal(response.body.issue.title, 'E2E renamed issue');
    assert.ok(response.body.issue.version > 1);
  });

  it('rejects a stale write with a version conflict', async () => {
    const response = await patch(`/api/issues/${issueId}`, {
      title: 'stale',
      expectedVersion: 1,
    });
    assert.equal(response.status, 409);
    assert.equal(response.body.error.code, 'version_conflict');
  });

  it('transitions the issue and rejects an illegal transition', async () => {
    const board = await get(`/api/projects/${projectId}/board`);
    const columns = board.body.columns as Array<{ key: string; statusId: number }>;
    const inProgress = columns.find((c) => c.key === 'in_progress');
    const inReview = columns.find((c) => c.key === 'in_review');

    const ok = await post(`/api/issues/${issueId}/transition`, { toStatusId: inProgress?.statusId });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.issue.state, 'in_progress');

    // backlog -> in_review has no edge in the default workflow.
    const created = await post('/api/issues', {
      projectId,
      title: 'illegal transition subject',
      description: '',
      type: 'task',
      priority: 'medium',
    });
    const blocked = await post(`/api/issues/${created.body.issue.id}/transition`, {
      toStatusId: inReview?.statusId,
    });
    assert.equal(blocked.status, 422);
    assert.equal(blocked.body.error.code, 'workflow_violation');
  });

  it('moves a card on the board', async () => {
    const board = await get(`/api/projects/${projectId}/board`);
    // The issue is In Progress at this point; In Review is the next legal hop.
    const column = board.body.columns.find((c: any) => c.key === 'in_review');
    const response = await post(`/api/projects/${projectId}/board/move`, {
      issueId,
      toStatusId: column.statusId,
      beforeIssueId: null,
      afterIssueId: null,
    });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(response.body.board.columns.length, board.body.columns.length);

    const moved = response.body.board.columns
      .find((c: any) => c.key === 'in_review')
      .issues.some((i: any) => i.id === issueId);
    assert.ok(moved, 'the card appears in its new column');
  });

  it('refuses a board move the workflow forbids', async () => {
    const board = await get(`/api/projects/${projectId}/board`);
    const closed = board.body.columns.find((c: any) => c.key === 'closed');
    // In Review -> Closed skips the resolution step and has no edge.
    const response = await post(`/api/projects/${projectId}/board/move`, {
      issueId,
      toStatusId: closed.statusId,
      beforeIssueId: null,
      afterIssueId: null,
    });
    assert.equal(response.status, 400, JSON.stringify(response.body));
    assert.equal(response.body.error.code, 'bad_request');
  });

  it('returns 404 for an unknown issue', async () => {
    const response = await get('/api/issues/99999999');
    assert.equal(response.status, 404);
    assert.equal(response.body.error.code, 'not_found');
  });
});

describe('collaboration over HTTP', () => {
  let issueId = 0;

  before(async () => {
    const created = await post('/api/issues', {
      projectId,
      title: 'collaboration subject',
      description: '',
      type: 'task',
      priority: 'medium',
    });
    issueId = created.body.issue.id;
  });

  it('posts a comment and reads it back', async () => {
    const posted = await post(`/api/issues/${issueId}/comments`, { body: 'A first comment.' });
    assert.equal(posted.status, 200, JSON.stringify(posted.body));
    assert.equal(posted.body.comment.body, 'A first comment.');

    const listed = await get(`/api/issues/${issueId}/comments`);
    assert.equal(listed.status, 200);
    assert.ok(listed.body.comments.length >= 1);
  });

  it('rejects an empty comment', async () => {
    const response = await post(`/api/issues/${issueId}/comments`, { body: '   ' });
    assert.equal(response.status, 422);
  });

  it('returns a timeline with the event stream', async () => {
    const response = await get(`/api/issues/${issueId}/timeline`);
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.ok(Array.isArray(response.body.events));
    assert.ok(response.body.timing, 'the timeline carries a timing block');
  });
});

describe('search over HTTP', () => {
  it('finds an issue by free text', async () => {
    const response = await get('/api/issues/search?q=collaboration%20subject');
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.ok(response.body.issues.length >= 1, 'the seeded issue should be found');
    assert.equal(response.body.issues[0].title, 'collaboration subject');
  });

  it('returns facet counts for the filter chips', async () => {
    const response = await get(`/api/issues/search/facets?projectId=${projectId}`);
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.ok(Array.isArray(response.body.states), 'state buckets are returned');
    assert.ok(response.body.total > 0);
  });

  it('does not blow up on a malformed FTS expression', async () => {
    const response = await get('/api/issues/search?q=' + encodeURIComponent('((( unbalanced'));
    assert.equal(response.status, 200, 'a bad query must degrade, not 500');
  });
});

describe('dashboards over HTTP', () => {
  it('provisions the default dashboards for a new project', async () => {
    const response = await get(`/api/dashboards/visible?projectId=${projectId}`);
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.ok(response.body.dashboards.length >= 4, 'the templates are provisioned');
  });

  it('renders a dashboard for an admin', async () => {
    const visible = await get(`/api/dashboards/visible?projectId=${projectId}`);
    const first = visible.body.dashboards[0];
    const rendered = await get(`/api/dashboards/${first.id}/render`);
    assert.equal(rendered.status, 200, JSON.stringify(rendered.body));
    assert.ok(Array.isArray(rendered.body.widgets));
  });

  it('lists a dashboard’s widgets on their own', async () => {
    const visible = await get(`/api/dashboards/visible?projectId=${projectId}`);
    const first = visible.body.dashboards[0];
    const response = await get(`/api/dashboards/${first.id}/widgets`);
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.ok(Array.isArray(response.body.widgets));
  });

  it('refuses the widget list for a dashboard the caller cannot see', async () => {
    const response = await get('/api/dashboards/999999/widgets');
    assert.equal(response.status, 404);
  });
});

describe('role catalogue over HTTP', () => {
  it('lists every role with its rank and grants', async () => {
    const response = await get(API.projects.roles.replace(':projectId', String(projectId)));
    assert.equal(response.status, 200, JSON.stringify(response.body));
    const roles = response.body.roles as Array<{ role: string; rank: number; permissions: string[] }>;
    assert.equal(roles.length, 6, 'six built-in roles');
    assert.deepEqual(
      roles.map((r) => r.role),
      ['owner', 'admin', 'maintainer', 'developer', 'reporter', 'viewer'],
    );
    // `ROLE_RANK` counts *down* with privilege: owner is 60, viewer is 10, so
    // "this role outranks you" is the comparison `rank < rank`. The guards in
    // the membership service rely on that direction, so the ordering a client
    // renders must preserve it.
    const ranks = roles.map((r) => r.rank);
    assert.deepEqual([...ranks].sort((a, b) => b - a), ranks, 'listed most privileged first');
    assert.equal(ranks[0], 60);
    assert.equal(ranks[ranks.length - 1], 10);
    assert.ok(
      (roles[0]?.permissions.length ?? 0) > (roles[roles.length - 1]?.permissions.length ?? 0),
      'an owner must be granted more than a viewer',
    );
  });

  it('requires a member-read grant', async () => {
    const outsider = await post(API.users.create, {
      username: 'nocatalog',
      email: 'nocatalog@example.com',
      displayName: 'No Catalog',
      password: 'Sup3rSecret!Pass',
    });
    assert.equal(outsider.status, 201);

    const login = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ login: 'nocatalog', password: 'Sup3rSecret!Pass' }),
    });
    const cookie = (login.headers.getSetCookie() ?? [])
      .map((c) => c.split(';')[0] as string)
      .find((c) => c.startsWith('tracker_session='));

    const response = await fetch(
      `${baseUrl}${API.projects.roles.replace(':projectId', String(projectId))}`,
      { headers: { cookie: cookie as string } },
    );
    assert.equal(response.status, 403, 'a non-member must not read the project role catalogue');
  });
});

describe('GitLab integration over HTTP', () => {
  it('rejects a non-https base URL', async () => {
    const response = await post('/api/gitlab/test', {
      baseUrl: 'http://gitlab.example.com',
      accessToken: 'glpat-abcdefghijklmnopqrst',
    });
    assert.equal(response.status, 422);
    assert.equal(response.body.error.code, 'validation_failed');
  });

  it('reports no connection before one is configured', async () => {
    const response = await get(`/api/projects/${projectId}/gitlab/status`);
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(response.body.connection, null, 'no connection is configured yet');
    assert.equal(response.body.unresolvedConflicts, 0);
  });
});

describe('audit trail over HTTP', () => {
  it('verifies the hash chain', async () => {
    const response = await get('/api/admin/audit/verify');
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(response.body.valid, true, response.body.message);
    assert.ok(response.body.entriesChecked > 0);
  });

  it('lists audit entries newest first', async () => {
    const response = await get('/api/admin/audit?limit=10');
    assert.equal(response.status, 200);
    assert.ok(response.body.entries.length > 0);
    assert.ok(response.body.entries[0].rowHash);
  });
});

describe('guest access', () => {
  it('mints a guest link and scopes the actor to one project', async () => {
    const created = await post(`/api/projects/${projectId}/guest-tokens`, {
      projectId,
      label: 'external reviewer',
      role: 'viewer',
      canComment: false,
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      maxUses: 3,
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));

    // 201 Created, and the raw token appears only in the shareable url.
    const raw = String(created.body.url ?? '').replace(/^\/guest\//, '');
    assert.ok(raw.length > 20, `expected a raw token in the url, got ${created.body.url}`);
    assert.equal(created.body.guestToken.tokenHash, undefined, 'the hash is never returned');

    const redeemed = await call('POST', '/api/auth/guest/redeem', {
      body: { token: raw },
      auth: false,
    });
    assert.equal(redeemed.status, 200, JSON.stringify(redeemed.body));
    assert.equal(redeemed.body.guest.projectId, projectId);
    assert.equal(redeemed.body.guest.role, 'viewer');
  });
});

describe('version-control linkage over HTTP', () => {
  let issueId = 0;
  let repositoryId = 0;

  before(async () => {
    const created = await post('/api/issues', {
      projectId,
      title: 'issue with linked work',
      description: '',
      type: 'task',
      priority: 'medium',
    });
    issueId = created.body.issue.id;

    const repository = await post(`/api/projects/${projectId}/repositories`, {
      provider: 'gitlab',
      name: 'platform/api-gateway',
      baseUrl: 'https://gitlab.example.com/platform/api-gateway',
      defaultBranch: 'main',
    });
    repositoryId = repository.body.repository.id;
  });

  it('rejects a plaintext repository URL', async () => {
    const response = await post(`/api/projects/${projectId}/repositories`, {
      provider: 'gitlab',
      name: 'bad-url',
      baseUrl: 'http://insecure.example.com/x',
      defaultBranch: 'main',
    });
    assert.equal(response.status, 422);
  });

  it('creates a repository', async () => {
    const response = await get(`/api/projects/${projectId}/repositories`);
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.ok(response.body.repositories.some((r: any) => r.id === repositoryId));
  });

  it('links a branch to an issue', async () => {
    const response = await post(`/api/issues/${issueId}/references`, {
      repositoryId,
      kind: 'branch',
      ref: 'feature/E2E-1-add-login',
      headSha: 'a'.repeat(40),
      state: 'open',
    });
    assert.equal(response.status, 201, JSON.stringify(response.body));
    assert.equal(response.body.reference.kind, 'branch');
  });

  it('rejects a javascript: URL, which would become an anchor href', async () => {
    const response = await post(`/api/issues/${issueId}/references`, {
      repositoryId,
      kind: 'commit',
      ref: 'b'.repeat(40),
      url: 'javascript:alert(1)',
    });
    assert.equal(response.status, 422, 'an unsafe scheme must not be stored');
  });

  it('rejects a non-hexadecimal headSha', async () => {
    const response = await post(`/api/issues/${issueId}/references`, {
      repositoryId,
      kind: 'commit',
      ref: 'c'.repeat(40),
      headSha: 'not-a-sha',
    });
    assert.equal(response.status, 422);
  });

  it('returns the references and a summary', async () => {
    const response = await get(`/api/issues/${issueId}/references`);
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(response.body.references.length, 1);
    assert.equal(response.body.summary.branches, 1);
    assert.equal(response.body.references[0].repositoryName, 'platform/api-gateway');
  });

  it('marks a reference merged and records it', async () => {
    const list = await get(`/api/issues/${issueId}/references`);
    const referenceId = list.body.references[0].id;

    const response = await patch(`/api/issues/${issueId}/references/${referenceId}`, {
      state: 'merged',
    });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(response.body.reference.state, 'merged');
  });

  it('previews what a branch name resolves to', async () => {
    const response = await post(
      `/api/projects/${projectId}/repositories/${repositoryId}/branch-rules/preview`,
      { branch: 'feature/E2E-1-whatever' },
    );
    assert.equal(response.status, 200, JSON.stringify(response.body));
    // With no rule configured nothing matches, and that is reported honestly.
    assert.equal(response.body.issueKey, null);
  });

  it('imports branches once a naming rule exists, and is idempotent', async () => {
    const rule = await post(`/api/projects/${projectId}/repositories/${repositoryId}/branch-rules`, {
      pattern: '^(?<key>E2E-\\d+)',
      stripPrefixes: ['feature/'],
      enabled: true,
    });
    assert.equal(rule.status, 201, JSON.stringify(rule.body));

    const first = await post(
      `/api/projects/${projectId}/repositories/${repositoryId}/branches/import`,
      { branches: [{ name: 'feature/E2E-1-auto-linked' }] },
    );
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.equal(first.body.result.linked, 1);

    const second = await post(
      `/api/projects/${projectId}/repositories/${repositoryId}/branches/import`,
      { branches: [{ name: 'feature/E2E-1-auto-linked' }] },
    );
    assert.equal(second.body.result.linked, 0, 'a second pass creates nothing new');
    assert.equal(second.body.result.updated, 1);
  });

  it('reports a branch naming a non-existent issue rather than dropping it', async () => {
    const response = await post(
      `/api/projects/${projectId}/repositories/${repositoryId}/branches/import`,
      { branches: [{ name: 'feature/E2E-9999-typo' }] },
    );
    assert.equal(response.body.result.unresolved.length, 1);
    assert.equal(response.body.result.unresolved[0].issueKey, 'E2E-9999');
  });

  it('rejects a rule with Python-style named groups', async () => {
    const response = await post(`/api/projects/${projectId}/repositories/${repositoryId}/branch-rules`, {
      pattern: '^(?P<key>E2E-\\d+)',
      enabled: true,
    });
    assert.equal(response.status, 422, 'JS spells a named group (?<key>...)');
  });

  it('unlinks a reference', async () => {
    const list = await get(`/api/issues/${issueId}/references`);
    const referenceId = list.body.references[0].id;
    const response = await call('DELETE', `/api/issues/${issueId}/references/${referenceId}`);
    assert.equal(response.status, 200);
    assert.equal((await get(`/api/issues/${issueId}/references`)).body.references.length, 0);
  });
});

/**
 * The single-entity workflow routes, over HTTP.
 *
 * `contract.test.ts` proves these paths are registered and `workflow.test.ts`
 * proves the service behaves; what only a real request can show is the wiring
 * between them -- path parameters, shared-schema validation, and the status
 * codes a client actually branches on.
 */
describe('attachment upload over HTTP', () => {
  let attachTo = 0;

  before(async () => {
    const created = await post(API.issues.create, { projectId, title: 'accepts log attachments' });
    assert.equal(created.status, 200, `issue create failed: ${JSON.stringify(created.body)}`);
    attachTo = created.body.issue.id;
  });

  it('accepts a multipart upload and lists it against the issue', async () => {
    const form = new FormData();
    form.append('file', new Blob(['deployment log line one\nline two\n'], { type: 'text/plain' }), 'deploy.log');

    const response = await fetch(`${baseUrl}/api/issues/${attachTo}/attachments`, {
      method: 'POST',
      headers: { cookie: sessionCookie },
      body: form,
    });
    // Read once: the body cannot be both read and parsed.
    const text = await response.text();
    assert.equal(response.status, 201, `upload failed: ${text}`);

    const created = JSON.parse(text) as {
      attachment: { id: number; filename: string; mimeType: string; sizeBytes: number };
    };
    assert.equal(created.attachment.filename, 'deploy.log');
    assert.equal(created.attachment.mimeType, 'text/plain');
    assert.ok(created.attachment.sizeBytes > 0, 'the stored size must be measured, not assumed');

    const listed = await get(`/api/issues/${attachTo}/attachments`);
    assert.equal(listed.status, 200);
    assert.ok(
      listed.body.attachments.some((a: { id: number }) => a.id === created.attachment.id),
      'the upload must appear in the issue’s attachment list',
    );

    // And it must be downloadable, or the upload achieved nothing.
    const download = await fetch(`${baseUrl}/api/attachments/${created.attachment.id}`, {
      headers: { cookie: sessionCookie },
    });
    assert.equal(download.status, 200);
    assert.match(await download.text(), /deployment log line one/);
  });

  it('rejects a request that is not multipart', async () => {
    const response = await post(`/api/issues/${attachTo}/attachments`, { filename: 'x.log' });
    assert.equal(response.status, 400, 'a JSON body cannot be an upload');
  });

  it('rejects a multipart body with no file part', async () => {
    const form = new FormData();
    form.append('commentId', '1');
    const response = await fetch(`${baseUrl}/api/issues/${attachTo}/attachments`, {
      method: 'POST',
      headers: { cookie: sessionCookie },
      body: form,
    });
    assert.equal(response.status, 400, 'a multipart body must actually carry a file');
  });
});

describe('SLA endpoints over HTTP', () => {
  let slaProject = 0;
  let policyId = 0;
  let watchedId = 0;

  before(async () => {
    const created = await post(API.projects.create, { key: 'SLA', name: 'SLA' });
    assert.equal(created.status, 200, `project create failed: ${JSON.stringify(created.body)}`);
    slaProject = created.body.project.id;

    const policy = await post(API.sla.createPolicy, {
      projectId: slaProject,
      name: 'Support',
      description: 'first response',
      appliesTo: { types: [], priorities: [], states: [], labelIds: [] },
      responseMinutes: 60,
      // A resolution target too, so the settle case below has a clock that
      // resolution actually ends. A response clock is met by a first comment,
      // not by closing the issue.
      resolutionMinutes: 1440,
      warningMinutes: 30,
      enabled: true,
    });
    assert.equal(policy.status, 201, `policy create failed: ${JSON.stringify(policy.body)}`);
    // The route answers with the policy itself, not a `{ policy }` envelope.
    policyId = policy.body.id;

    const issue = await post(API.issues.create, { projectId: slaProject, title: 'needs a reply' });
    assert.equal(issue.status, 200, `issue create failed: ${JSON.stringify(issue.body)}`);
    watchedId = issue.body.issue.id;
  });

  it('lists the project policy', async () => {
    const response = await get(`${API.sla.policies}?projectId=${slaProject}`);
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.ok(response.body.policies.some((p: { id: number }) => p.id === policyId));
  });

  it('reports a clock for an issue the policy applies to', async () => {
    const response = await get(`/api/issues/${watchedId}/sla`);
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.ok(response.body.clocks.length > 0, 'an open issue under a policy has a running clock');

    const clock = response.body.clocks[0];
    assert.equal(clock.issueId, watchedId);
    assert.equal(typeof clock.state, 'string');
    assert.ok(clock.startsAt, 'a clock says when it started');
    assert.ok(clock.dueAt, 'an unmet clock has a deadline');
  });

  it('does not invent a clock for an issue no policy covers', async () => {
    const other = await post(API.projects.create, { key: 'SLA2', name: 'SLA 2' });
    assert.equal(other.status, 200);
    const issue = await post(API.issues.create, {
      projectId: other.body.project.id,
      title: 'uncovered',
    });
    assert.equal(issue.status, 200);
    const response = await get(`/api/issues/${issue.body.issue.id}/sla`);
    assert.equal(response.status, 200);
    assert.deepEqual(response.body.clocks, [], 'no policy applies, so there is no clock');
  });

  it('settles a clock once the work happens, so it cannot report a false breach', async () => {
    // The clock was created while the issue was open. Resolving the issue
    // afterwards must not leave a clock still running towards a deadline it
    // will now "breach".
    const issue = await post(API.issues.create, { projectId: slaProject, title: 'resolved late' });
    assert.equal(issue.status, 200);
    const id = issue.body.issue.id;

    const before = await get(`/api/issues/${id}/sla`);
    assert.ok(before.body.clocks.length > 0, 'precondition: a clock is running');

    const past = new Date(Date.now() - 86_400_000).toISOString();
    tracker.db.run('UPDATE issues SET resolved_at = ?, closed_at = ? WHERE id = ?', [past, past, id]);

    const after = await get(`/api/issues/${id}/sla`);
    const resolution = after.body.clocks.find((c: { target: string }) => c.target === 'resolution');
    assert.ok(resolution, 'precondition: the policy sets a resolution target');
    assert.notEqual(resolution.state, 'breached', 'a resolved issue must not read as breached');
    assert.ok(resolution.metAt !== null, 'resolution meets the resolution clock');
  });

  it('scopes a project request to that project, not the whole instance', async () => {
    // An instance admin can see every project, so a request naming one project
    // must still be limited to it. The route reads a plural `projectIds`; a
    // singular `projectId` was ignored, which turned "this project" into
    // "everything" without any visible difference in the response shape.
    const elsewhere = await post(API.projects.create, { key: 'SLA9', name: 'SLA 9' });
    assert.equal(elsewhere.status, 200);
    const policy = await post(API.sla.createPolicy, {
      projectId: elsewhere.body.project.id,
      name: 'Elsewhere',
      description: '',
      responseMinutes: 30,
      resolutionMinutes: null,
      enabled: true,
    });
    assert.equal(policy.status, 201);
    const otherIssue = await post(API.issues.create, {
      projectId: elsewhere.body.project.id,
      title: 'over there',
    });
    assert.equal(otherIssue.status, 200);

    const scoped = await get(`${API.sla.atRisk}?projectId=${slaProject}&windowMs=${7 * 86_400_000}`);
    assert.equal(scoped.status, 200, JSON.stringify(scoped.body));
    const otherIssueId = otherIssue.body.issue.id;
    assert.ok(
      !scoped.body.clocks.some((c: { issueId: number }) => c.issueId === otherIssueId),
      'naming one project must not return another project’s clocks',
    );

    const breaches = await get(`${API.sla.breached}?projectId=${slaProject}`);
    assert.ok(
      !breaches.body.clocks.some((c: { issueId: number }) => c.issueId === otherIssueId),
      'the breached list is scoped the same way',
    );
  });

  it('lists at-risk and breached clocks for a project', async () => {
    const atRisk = await get(`${API.sla.atRisk}?projectId=${slaProject}&windowMs=${7 * 86_400_000}`);
    assert.equal(atRisk.status, 200, JSON.stringify(atRisk.body));
    assert.ok(Array.isArray(atRisk.body.clocks));

    const breached = await get(`${API.sla.breached}?projectId=${slaProject}`);
    assert.equal(breached.status, 200, JSON.stringify(breached.body));
    assert.ok(Array.isArray(breached.body.clocks));
    for (const clock of breached.body.clocks) {
      assert.equal(clock.breached, true, 'everything in the breached list really is breached');
    }
  });

  it('refuses SLA data for a project the caller cannot read', async () => {
    const user = await post(API.users.create, {
      username: 'slaoutsider',
      email: 'slaoutsider@example.com',
      displayName: 'SLA Outsider',
      password: 'Sup3rSecret!Pass',
    });
    assert.equal(user.status, 201);
    const login = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ login: 'slaoutsider', password: 'Sup3rSecret!Pass' }),
    });
    const cookie = (login.headers.getSetCookie() ?? [])
      .map((c) => c.split(';')[0] as string)
      .find((c) => c.startsWith('tracker_session='));

    for (const path of [
      `${API.sla.policies}?projectId=${slaProject}`,
      `/api/issues/${watchedId}/sla`,
    ]) {
      const response = await fetch(`${baseUrl}${path}`, { headers: { cookie: cookie as string } });
      assert.equal(response.status, 403, `${path} must not be readable by a non-member`);
    }

    // The at-risk and breached lists are a different shape: they fall back to
    // "every project this caller can see", which for a non-member is none. The
    // requirement is that nothing leaks, not that the status is uniform.
    for (const path of [
      `${API.sla.atRisk}?projectId=${slaProject}&windowMs=${7 * 86_400_000}`,
      `${API.sla.breached}?projectId=${slaProject}`,
    ]) {
      const response = await fetch(`${baseUrl}${path}`, { headers: { cookie: cookie as string } });
      assert.equal(response.status, 403, `${path} names a project the caller is not in`);
      const body = await response.json().catch(() => ({ clocks: [] }));
      assert.deepEqual(body.clocks ?? [], [], `${path} must return no clocks`);
    }
  });
});

describe('stale-issue archiving over HTTP', () => {
  let archProject = 0;
  let staleKey = '';

  before(async () => {
    const created = await post(API.projects.create, { key: 'ARCH', name: 'Archive' });
    assert.equal(created.status, 200, `project create failed: ${JSON.stringify(created.body)}`);
    archProject = created.body.project.id;

    // Two issues: one quiet for a year, one touched today. A 30-day policy
    // should reach exactly one of them.
    const stale = await post(API.issues.create, { projectId: archProject, title: 'forgotten work' });
    const fresh = await post(API.issues.create, { projectId: archProject, title: 'in flight' });
    assert.equal(stale.status, 200, `issue create failed: ${JSON.stringify(stale.body)}`);
    assert.equal(fresh.status, 200, `issue create failed: ${JSON.stringify(fresh.body)}`);
    staleKey = stale.body.issue.key;

    // Age is set directly rather than by waiting a year: both the candidate
    // query and the search index read `updated_at`.
    const longAgo = new Date(Date.now() - 365 * 86_400_000).toISOString();
    tracker.db.run('UPDATE issues SET updated_at = ? WHERE id = ?', [
      longAgo,
      stale.body.issue.id,
    ]);
  });

  const archivedFlag = (key: string): number =>
    Number(
      (tracker.db.get<{ archived: number }>('SELECT archived FROM issues WHERE key = ?', [key]) ??
        {})['archived'] ?? 0,
    );

  it('reports no policy before one is set', async () => {
    const response = await get(`${API.archive.policy}?projectId=${archProject}`);
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(response.body.policy, null, 'a project starts with no archive policy');
  });

  it('saves a policy and reads it back', async () => {
    const saved = await call('PUT', API.archive.policy, {
      body: {
        projectId: archProject,
        inactiveDays: 30,
        states: ['closed'],
        skipIssuesWithOpenSubtasks: true,
        requireCommentWithinDays: null,
        enabled: true,
      },
    });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert.equal(saved.body.policy.inactiveDays, 30);

    const read = await get(`${API.archive.policy}?projectId=${archProject}`);
    assert.equal(read.body.policy.inactiveDays, 30);
    // Null means "no comment requirement"; zero is a different instruction and
    // must not be what a blank field turns into.
    assert.equal(read.body.policy.requireCommentWithinDays, null);
  });

  it('rejects a policy the schema will not accept', async () => {
    const response = await call('PUT', API.archive.policy, {
      body: { projectId: archProject, inactiveDays: 0 },
    });
    assert.equal(response.status, 422, 'inactiveDays has a documented minimum of 1');
  });

  it('lists candidates and says why each one qualifies', async () => {
    const response = await get(`${API.archive.candidates}?projectId=${archProject}`);
    assert.equal(response.status, 200, JSON.stringify(response.body));
    for (const candidate of response.body.candidates) {
      assert.ok(candidate.key, 'a candidate names its issue');
      assert.ok(Array.isArray(candidate.reasons), 'a candidate explains itself');
      assert.equal(typeof candidate.daysInactive, 'number');
    }
  });

  it('archives what the policy matches and reports the outcome', async () => {
    const run = await post(API.archive.run, { projectId: archProject });
    assert.equal(run.status, 200, JSON.stringify(run.body));
    assert.equal(typeof run.body.archived, 'number');
    assert.equal(typeof run.body.skipped, 'number');
    assert.ok(Array.isArray(run.body.issues), 'the run names the issues it touched');

    for (const key of run.body.issues) {
      assert.equal(archivedFlag(key), 1, `${key} should be archived after the run`);
    }
    // Whatever was archived must still be readable — archiving hides, not deletes.
    for (const key of run.body.issues) {
      const row = tracker.db.get<{ id: number }>('SELECT id FROM issues WHERE key = ?', [key]);
      const issue = await get(`/api/issues/${row?.id}`);
      assert.equal(issue.status, 200, 'an archived issue is still fetchable');
    }
  });

  it('is idempotent — a second run archives nothing new', async () => {
    const second = await post(API.archive.run, { projectId: archProject });
    assert.equal(second.status, 200);
    assert.equal(
      second.body.archived,
      0,
      'a second run over the same policy must not archive anything again',
    );
  });

  it('refuses to list candidates or run without permission', async () => {
    const user = await post(API.users.create, {
      username: 'archoutsider',
      email: 'archoutsider@example.com',
      displayName: 'Arch Outsider',
      password: 'Sup3rSecret!Pass',
    });
    assert.equal(user.status, 201);
    const login = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ login: 'archoutsider', password: 'Sup3rSecret!Pass' }),
    });
    const cookie = (login.headers.getSetCookie() ?? [])
      .map((c) => c.split(';')[0] as string)
      .find((c) => c.startsWith('tracker_session='));

    const read = await fetch(`${baseUrl}${API.archive.candidates}?projectId=${archProject}`, {
      headers: { cookie: cookie as string },
    });
    assert.equal(read.status, 403, 'candidates must not leak to a non-member');

    const run = await fetch(`${baseUrl}${API.archive.run}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: cookie as string },
      body: JSON.stringify({ projectId: archProject }),
    });
    assert.equal(run.status, 403, 'a non-member must not trigger an archive run');
  });
});

describe('data export over HTTP', () => {
  let expProject = 0;
  let expIds: number[] = [];

  before(async () => {
    const created = await post(API.projects.create, { key: 'EXP', name: 'Export' });
    assert.equal(created.status, 200, `project create failed: ${JSON.stringify(created.body)}`);
    expProject = created.body.project.id;
    for (const title of ['export me one', 'export me two', 'unrelated work']) {
      const issue = await post(API.issues.create, { projectId: expProject, title });
      assert.equal(issue.status, 200, `issue create failed: ${JSON.stringify(issue.body)}`);
      expIds.push(issue.body.issue.id);
    }
  });

  it('answers with a file, not JSON', async () => {
    const response = await fetch(`${baseUrl}${API.export.run}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: sessionCookie },
      body: JSON.stringify({ projectId: expProject, format: 'csv' }),
    });
    assert.equal(response.status, 200);

    // The client downloads this; it must not be something the JSON path could parse.
    const disposition = response.headers.get('content-disposition') ?? '';
    assert.match(disposition, /attachment/, 'an export is always a file the user saves');
    assert.match(disposition, /filename="[^"]+"/, 'the server names the file');
    assert.ok(
      !(response.headers.get('content-type') ?? '').includes('application/json'),
      'a CSV export must not claim to be JSON',
    );

    const body = await response.text();
    assert.match(body, /export me one/, 'the export contains the project issues');
  });

  it('exports only the requested issues', async () => {
    const response = await fetch(`${baseUrl}${API.export.run}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: sessionCookie },
      body: JSON.stringify({ projectId: expProject, format: 'json', issueIds: [expIds[0] as number] }),
    });
    assert.equal(response.status, 200);
    const parsed = JSON.parse(await response.text()) as { issues: unknown[] };
    assert.equal(parsed.issues.length, 1, 'a selection export must not widen');
  });

  it('treats an omitted filter as "everything", not "nothing"', async () => {
    // The trap: sending empty arrays would read as "priority in ()" and export
    // zero issues, so a user with no filters applied would get an empty file.
    const bare = await fetch(`${baseUrl}${API.export.run}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: sessionCookie },
      body: JSON.stringify({ projectId: expProject, format: 'json', filter: {} }),
    });
    const withEmptyArrays = await fetch(`${baseUrl}${API.export.run}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: sessionCookie },
      body: JSON.stringify({
        projectId: expProject,
        format: 'json',
        filter: { priorities: [], states: [], types: [] },
      }),
    });
    assert.equal(bare.status, 200);
    assert.equal(withEmptyArrays.status, 200);

    const bareCount = (JSON.parse(await bare.text()) as { issues: unknown[] }).issues.length;
    const emptyCount = (JSON.parse(await withEmptyArrays.text()) as { issues: unknown[] }).issues.length;
    assert.equal(bareCount, 3);
    assert.equal(emptyCount, 3, 'empty filter lists must not narrow the export to nothing');
  });

  it('refuses an export from a user without the permission', async () => {
    const user = await post(API.users.create, {
      username: 'expoutsider',
      email: 'expoutsider@example.com',
      displayName: 'Exp Outsider',
      password: 'Sup3rSecret!Pass',
    });
    assert.equal(user.status, 201);
    const login = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ login: 'expoutsider', password: 'Sup3rSecret!Pass' }),
    });
    const cookie = (login.headers.getSetCookie() ?? [])
      .map((c) => c.split(';')[0] as string)
      .find((c) => c.startsWith('tracker_session='));

    const response = await fetch(`${baseUrl}${API.export.run}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: cookie as string },
      body: JSON.stringify({ projectId: expProject, format: 'json' }),
    });
    assert.equal(response.status, 403, 'issues must not be exportable by a non-member');
  });
});

describe('bulk editing over HTTP', () => {
  let bulkProject = 0;
  let bulkIds: number[] = [];

  before(async () => {
    const created = await post(API.projects.create, { key: 'BULK', name: 'Bulk' });
    assert.equal(created.status, 200, `project create failed: ${JSON.stringify(created.body)}`);
    bulkProject = created.body.project.id;

    for (let i = 0; i < 3; i += 1) {
      const issue = await post(API.issues.create, {
        projectId: bulkProject,
        title: `bulk candidate ${i}`,
        priority: 'low',
      });
      assert.equal(issue.status, 200, `issue create failed: ${JSON.stringify(issue.body)}`);
      bulkIds.push(issue.body.issue.id);
    }
  });

  it('previews without writing anything', async () => {
    const operations = [{ op: 'setPriority', priority: 'critical' }];
    const preview = await post('/api/issues/bulk/preview', { issueIds: bulkIds, operations });
    assert.equal(preview.status, 200, `preview failed: ${JSON.stringify(preview.body)}`);
    assert.equal(preview.body.requested, 3);
    assert.equal(preview.body.eligible, 3, 'the owner may edit all of them');
    assert.equal(preview.body.operations.length, 1);
    assert.equal(preview.body.operations[0].wouldChange, 3, 'all three are currently low');
    assert.ok(
      String(preview.body.operations[0].label).length > 0,
      'the preview must describe the change in words, not just count it',
    );

    // The whole point of a preview: nothing was written.
    for (const id of bulkIds) {
      const issue = await get(`/api/issues/${id}`);
      assert.equal(issue.body.issue.priority, 'low', 'a preview must not change the issue');
    }
  });

  it('applies to the selection and reports per-issue results', async () => {
    const result = await post(API.bulk.apply, {
      issueIds: bulkIds,
      operations: [{ op: 'setPriority', priority: 'critical' }],
    });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(result.body.requested, 3);
    assert.equal(result.body.succeeded, 3);
    assert.equal(result.body.failed, 0);
    assert.equal(result.body.results.length, 3, 'every issue reports its own outcome');

    for (const id of bulkIds) {
      const issue = await get(`/api/issues/${id}`);
      assert.equal(issue.body.issue.priority, 'critical', `issue ${id} should have changed`);
    }
  });

  it('reports a no-op preview rather than pretending work happened', async () => {
    // The three issues are already critical. A preview that claimed 3 changes
    // would be a lie, and a bulk bar that showed it would push people to apply
    // an edit that does nothing.
    const preview = await post('/api/issues/bulk/preview', {
      issueIds: bulkIds,
      operations: [{ op: 'setPriority', priority: 'critical' }],
    });
    assert.equal(preview.status, 200);
    assert.equal(
      preview.body.operations[0].wouldChange,
      0,
      'an edit that changes nothing must be reported as changing nothing',
    );
  });

  it('rejects an empty selection rather than doing nothing quietly', async () => {
    const response = await post(API.bulk.apply, {
      issueIds: [],
      operations: [{ op: 'setPriority', priority: 'low' }],
    });
    assert.equal(response.status, 422, 'the schema requires at least one issue');
  });

  it('isolates a failure instead of aborting the whole batch', async () => {
    const result = await post(API.bulk.apply, {
      issueIds: [...bulkIds, 999_999],
      operations: [{ op: 'setPriority', priority: 'low' }],
      continueOnError: true,
    });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(result.body.succeeded, 3, 'the real issues still change');
    assert.equal(result.body.failed, 1, 'the missing one is reported, not thrown');
    const missing = result.body.results.find((r: { issueId: number }) => r.issueId === 999_999);
    assert.equal(missing.ok, false);
    assert.ok(missing.error, 'a failed row explains itself');
  });

  it('refuses bulk editing without the permission', async () => {
    const viewer = await post(API.users.create, {
      username: 'bulkviewer',
      email: 'bulkviewer@example.com',
      displayName: 'Bulk Viewer',
      password: 'Sup3rSecret!Pass',
    });
    assert.equal(viewer.status, 201);

    const login = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ login: 'bulkviewer', password: 'Sup3rSecret!Pass' }),
    });
    const cookie = (login.headers.getSetCookie() ?? [])
      .map((c) => c.split(';')[0] as string)
      .find((c) => c.startsWith('tracker_session='));

    const response = await fetch(`${baseUrl}${API.bulk.apply}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: cookie as string },
      body: JSON.stringify({
        issueIds: bulkIds,
        operations: [{ op: 'setPriority', priority: 'low' }],
      }),
    });
    assert.equal(response.status, 403, 'a user with no project role cannot bulk edit');
  });
});

describe('duplicate review endpoints', () => {
  let dupProject = 0;
  let pairKey = '';

  before(async () => {
    const created = await post(API.projects.create, { key: 'DUP', name: 'Duplicates' });
    assert.equal(created.status, 200, `project create failed: ${JSON.stringify(created.body)}`);
    dupProject = created.body.project.id;

    // Two issues with near-identical titles, so the scan has something to find.
    for (const title of [
      'Checkout times out when applying a discount code',
      'Checkout times out when applying discount code',
    ]) {
      const issue = await post(API.issues.create, { projectId: dupProject, title });
      assert.equal(issue.status, 200, `issue create failed: ${JSON.stringify(issue.body)}`);
    }
    pairKey = `${dupProject}`;
  });

  it('scans, lists, and dismisses a detected pair', async () => {
    // `autoLink` is what persists a scan as reviewable links; without it the
    // server compares and returns without storing anything.
    const scan = await post(API.dedupe.scan, {
      projectId: dupProject,
      minConfidence: 0.5,
      autoLink: true,
    });
    assert.equal(scan.status, 200, `scan failed: ${JSON.stringify(scan.body)}`);
    assert.ok(scan.body.count >= 1, 'the near-identical titles should be detected');

    const listed = await get(`${API.dedupe.candidates}?projectId=${pairKey}`);
    assert.equal(listed.status, 200, JSON.stringify(listed.body));
    const candidate = listed.body.candidates[0];
    assert.ok(candidate, 'a detected pair should be listed for review');
    assert.ok(candidate.sourceKey && candidate.targetKey, 'both sides of the pair are named');
    assert.ok(candidate.sourceTitle && candidate.targetTitle, 'both titles are returned for review');

    // Dismiss removes the detected link, and only the link.
    const dismissed = await call('DELETE', `/api/dedupe/candidates/${candidate.linkId}`);
    assert.equal(dismissed.status, 200, JSON.stringify(dismissed.body));

    const after = await get(`${API.dedupe.candidates}?projectId=${pairKey}`);
    assert.ok(
      !after.body.candidates.some((c: { linkId: number }) => c.linkId === candidate.linkId),
      'the dismissed pair must leave the review queue',
    );

    // Neither issue may be touched by a dismissal. Checked by id rather than
    // by counting a search, which spans every project the caller can see.
    for (const id of [candidate.sourceIssueId, candidate.targetIssueId]) {
      const issue = await get(`/api/issues/${id}`);
      assert.equal(issue.status, 200, `dismissing a pair must not remove issue ${id}`);
      assert.ok(issue.body.issue.key, 'the issue keeps its key');
    }
  });

  it('refuses to list candidates for a project the caller cannot read', async () => {
    const outsider = await post(API.users.create, {
      username: 'dupoutsider',
      email: 'dupoutsider@example.com',
      displayName: 'Dup Outsider',
      password: 'Sup3rSecret!Pass',
    });
    assert.equal(outsider.status, 201);

    const login = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ login: 'dupoutsider', password: 'Sup3rSecret!Pass' }),
    });
    const cookie = (login.headers.getSetCookie() ?? [])
      .map((c) => c.split(';')[0] as string)
      .find((c) => c.startsWith('tracker_session='));

    const response = await fetch(`${baseUrl}${API.dedupe.candidates}?projectId=${dupProject}`, {
      headers: { cookie: cookie as string },
    });
    assert.equal(response.status, 403, 'duplicate candidates must not leak across projects');
  });
});

describe('workflow editing endpoints', () => {
  const base = (suffix: string) => `/api/projects/${projectId}/workflow${suffix}`;

  const newStatus = (over: Record<string, unknown> = {}) => ({
    key: 'triage',
    name: 'Triage',
    state: 'open',
    color: '#123456',
    description: '',
    position: 0,
    isResolution: false,
    isClosed: false,
    isDone: false,
    wipLimit: null,
    ...over,
  });

  it('lists the statuses of a project', async () => {
    const response = await get(base('/statuses'));
    assert.equal(response.status, 200);
    assert.ok(response.body.statuses.length > 0, 'a provisioned workflow has statuses');
    assert.ok(response.body.statuses.some((s: { key: string }) => s.key === 'open'));
  });

  it('adds, patches and removes a single status', async () => {
    const created = await post(base('/statuses'), newStatus());
    assert.equal(created.status, 200, JSON.stringify(created.body));
    assert.equal(created.body.status.key, 'triage');
    // The category is derived from the state when the caller omits it.
    assert.equal(created.body.status.category, 'unstarted');

    const patched = await patch(
      base(`/statuses/${created.body.status.id}`),
      { name: 'Needs triage' },
    );
    assert.equal(patched.status, 200);
    assert.equal(patched.body.status.name, 'Needs triage');
    assert.equal(patched.body.status.key, 'triage', 'the key must not move on rename');

    const removed = await call('DELETE', base(`/statuses/${created.body.status.id}`));
    assert.equal(removed.status, 200);
    assert.equal(removed.body.removed, true);

    const again = await call('DELETE', base(`/statuses/${created.body.status.id}`));
    assert.equal(again.status, 404, 'removing it twice is not a silent success');
  });

  it('reports a duplicate status key as a conflict', async () => {
    assert.equal((await post(base('/statuses'), newStatus())).status, 200);
    const duplicate = await post(base('/statuses'), newStatus());
    assert.equal(duplicate.status, 409);
    assert.equal(duplicate.body.error.code, 'conflict');
  });

  it('rejects a malformed status body with a validation error', async () => {
    const response = await post(base('/statuses'), { key: 'Bad Key', name: '' });
    assert.equal(response.status, 422, 'the shared schema is the only validator');
    assert.equal(response.body.error.code, 'validation_failed');
  });

  it('lists, adds and removes a transition', async () => {
    const statuses = (await get(base('/statuses'))).body.statuses;
    const backlog = statuses.find((s: { key: string }) => s.key === 'backlog');
    const inProgress = statuses.find((s: { key: string }) => s.key === 'in_progress');
    assert.ok(backlog && inProgress);

    const created = await post(base('/transitions'), {
      fromStatusId: backlog.id,
      toStatusId: inProgress.id,
      name: 'Skip triage',
      description: '',
      requiredPermission: null,
    });
    assert.equal(created.status, 200, JSON.stringify(created.body));
    const transitionId = created.body.transition.id;

    const listed = await get(base('/transitions'));
    assert.ok(listed.body.transitions.some((t: { id: number }) => t.id === transitionId));

    const removed = await call('DELETE', base(`/transitions/${transitionId}`));
    assert.equal(removed.status, 200);
    assert.equal(
      (await get(base('/transitions'))).body.transitions.some((t: { id: number }) => t.id === transitionId),
      false,
    );
  });

  it('refuses a status id from another project', async () => {
    const other = await post(API.projects.create, { key: 'E2E2', name: 'Other' });
    assert.equal(other.status, 200);
    const otherStatuses = await get(`/api/projects/${other.body.project.id}/workflow/statuses`);
    const foreign = otherStatuses.body.statuses[0];

    const response = await patch(`/api/projects/${other.body.project.id}/workflow/statuses/${foreign.id}`, {
      name: 'hijacked',
    });
    assert.equal(response.status, 200, 'a project may edit its own status');

    // The same id addressed through the *first* project must not resolve.
    const crossProject = await patch(base(`/statuses/${foreign.id}`), { name: 'hijacked' });
    assert.equal(crossProject.status, 404, 'a status id is not global');
  });

  it('requires authentication', async () => {
    const saved = sessionCookie;
    sessionCookie = '';
    try {
      const response = await get(base('/statuses'));
      assert.equal(response.status, 401);
    } finally {
      sessionCookie = saved;
    }
  });
});