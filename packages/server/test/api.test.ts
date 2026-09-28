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