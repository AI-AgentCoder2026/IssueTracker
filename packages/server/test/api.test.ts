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
