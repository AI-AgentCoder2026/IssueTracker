/**
 * GitLab synchronisation, and the configurable source-of-truth rule.
 *
 * These tests run against a real HTTP server that speaks enough of the GitLab
 * v4 API, rather than a mocked client. A mock would happily agree with a
 * mis-shaped request, which is exactly the class of bug that turns a sync into
 * silent data loss.
 *
 * The property under test throughout: **a sync must never silently discard work
 * on either side.** Whichever side loses, the losing value has to appear in
 * `gitlab_sync_conflicts` for a human to resolve.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { createHarness, insertUser, createProject, type TestHarness } from './helpers.ts';
import type { RequestContext } from '../src/services/context.ts';
import type { GitLabIssuePayload } from '@tracker/shared';

const PROJECT_ID = 4242;

// ---------------------------------------------------------------------------
// A stand-in GitLab instance
// ---------------------------------------------------------------------------

interface RemoteState {
  issues: Map<string, GitLabIssuePayload>;
  notes: Map<string, string[]>;
  /** Every write the client made, for asserting what was pushed. */
  writes: Array<{ method: string; path: string; body: unknown }>;
  /** Set to make the next request fail, exercising the error path. */
  failNext: number | null;
  nextIid: number;
}

function isoNow(): string {
  return new Date().toISOString();
}

function startFakeGitLab(): Promise<{ server: Server; state: RemoteState; url: string }> {
  const state: RemoteState = {
    issues: new Map(),
    notes: new Map(),
    writes: [],
    failNext: null,
    nextIid: 100,
  };

  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      const body = raw.length > 0 ? (JSON.parse(raw) as unknown) : undefined;
      const url = new URL(request.url ?? '/', 'http://localhost');
      const method = request.method ?? 'GET';

      if (state.failNext !== null && state.failNext > 0) {
        state.failNext -= 1;
        response.writeHead(500, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ message: 'injected failure' }));
        return;
      }

      if (method !== 'GET') {
        state.writes.push({ method, path: url.pathname, body });
      }

      const send = (status: number, payload: unknown, headers: Record<string, string> = {}): void => {
        response.writeHead(status, { 'content-type': 'application/json', ...headers });
        response.end(JSON.stringify(payload));
      };

      // -- project and user probes ------------------------------------------
      if (url.pathname === '/api/v4/user') {
        send(200, { id: 1, username: 'idp-bot', name: 'Sync Bot' });
        return;
      }
      if (url.pathname.startsWith('/api/v4/projects/') && url.pathname.endsWith('/issues') && method === 'GET') {
        const page = Number(url.searchParams.get('page') ?? '1');
        if (page > 1) {
          // A single page is enough; an empty second page terminates pagination.
          send(200, [], { 'x-next-page': '' });
          return;
        }
        const items = [...state.issues.values()];
        send(200, items, { 'x-next-page': '' });
        return;
      }
      if (url.pathname.includes('/notes')) {
        const issueId = url.pathname.split('/issues/')[1]?.split('/')[0] ?? '';
        if (method === 'GET') {
          send(200, (state.notes.get(issueId) ?? []).map((body, index) => ({ id: index + 1, body })));
          return;
        }
        const text = (body as { body?: string } | undefined)?.body ?? '';
        state.notes.set(issueId, [...(state.notes.get(issueId) ?? []), text]);
        send(201, { id: 1, body: text });
        return;
      }
      if (url.pathname.includes('/labels') && method === 'GET') {
        send(200, [], { 'x-next-page': '' });
        return;
      }
      if (url.pathname.includes('/members') && method === 'GET') {
        send(200, [], { 'x-next-page': '' });
        return;
      }
      if (url.pathname.endsWith('/issues') && method === 'POST') {
        const payload = body as Partial<GitLabIssuePayload>;
        state.nextIid += 1;
        const issue: GitLabIssuePayload = {
          id: state.nextIid,
          iid: state.nextIid,
          project_id: PROJECT_ID,
          title: String(payload.title ?? ''),
          description: String(payload.description ?? ''),
          state: payload.state ?? 'opened',
          labels: payload.labels ?? [],
          created_at: isoNow(),
          updated_at: isoNow(),
          closed_at: null,
          due_date: null,
          weight: null,
          author: { id: 1, name: 'Sync Bot', username: 'idp-bot' },
          assignees: [],
          web_url: `https://gitlab.example.com/d/-/issues/${state.nextIid}`,
        };
        state.issues.set(String(state.nextIid), issue);
        send(201, issue);
        return;
      }

      const issueMatch = /\/issues\/(\d+)$/.exec(url.pathname);
      if (issueMatch) {
        const iid = issueMatch[1] as string;
        const existing = state.issues.get(iid);
        if (!existing) {
          send(404, { message: '404 Not found' });
          return;
        }
        if (method === 'DELETE') {
          state.issues.delete(iid);
          send(204, {});
          return;
        }
        if (method === 'PUT') {
          const payload = body as Partial<GitLabIssuePayload>;
          const updated: GitLabIssuePayload = {
            ...existing,
            title: payload.title ?? existing.title,
            description: payload.description ?? existing.description,
            state: payload.state ?? existing.state,
            labels: payload.labels ?? existing.labels,
            updated_at: isoNow(),
          };
          state.issues.set(iid, updated);
          send(200, updated);
          return;
        }
        if (method === 'GET') {
          send(200, existing);
          return;
        }
      }

      if (url.pathname.startsWith('/api/v4/projects/') && method === 'GET') {
        send(200, {
          id: PROJECT_ID,
          path_with_namespace: 'team/project',
          name: 'project',
          web_url: 'https://gitlab.example.com/team/project',
          default_branch: 'main',
          visibility: 'private',
          issues_enabled: true,
        });
        return;
      }

      send(404, { message: `no route for ${method} ${url.pathname}` });
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      resolve({ server, state, url: `http://127.0.0.1:${port}` });
    });
  });
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

let harness: TestHarness;
let gitlab: { server: Server; state: RemoteState; url: string };
let projectId: number;
let userId: number;
let connectionId: number;


/**
 * A request context shaped like the real one.
 *
 * Earlier revisions of this file cast partial literals with `as never`, which
 * hid a genuine mismatch: the service reads `ctx.actor.userId`, not a
 * top-level `actorId`.
 */
function requestContext(userId: number, harness: TestHarness): RequestContext {
  return {
    services: harness.services,
    db: harness.db,
    config: harness.config,
    actor: {
      userId,
      isInstanceAdmin: true,
      roles: ['admin'],
      projectRoles: new Map([[userId, 'owner']]),
    },
    guest: null,
    requestId: 'test',
    ip: '127.0.0.1',
    userAgent: 'test',
    auditContext: { actorId: userId, ipAddress: '127.0.0.1', userAgent: 'test' },
  };
}

async function newIssue(title: string, overrides: Partial<Parameters<typeof harness.services.issues.create>[1]> = {}) {
  const result = await harness.services.issues.create(
    projectId,
    { title, description: '', type: 'task', priority: 'medium', ...overrides },
    userId,
    { actorId: userId },
  );
  return result.issue;
}

/** Put an issue on the remote, as if it already existed there. */
function seedRemoteIssue(fields: { title: string; description?: string; state?: 'opened' | 'closed'; labels?: string[] }): GitLabIssuePayload {
  const iid = gitlab.state.nextIid;
  gitlab.state.nextIid += 1;
  const issue: GitLabIssuePayload = {
    id: iid,
    iid,
    project_id: PROJECT_ID,
    title: fields.title,
    description: fields.description ?? '',
    state: fields.state ?? 'opened',
    labels: fields.labels ?? [],
    created_at: isoNow(),
    updated_at: isoNow(),
    closed_at: null,
    due_date: null,
    weight: null,
    author: { id: 1, name: 'Remote User', username: 'remote' },
    assignees: [],
    web_url: `https://gitlab.example.com/d/-/issues/${iid}`,
  };
  gitlab.state.issues.set(String(iid), issue);
  return issue;
}

/** Edit an issue on the remote, bumping its `updated_at`. */
function editRemoteIssue(iid: number, patch: Partial<GitLabIssuePayload>): void {
  const key = String(iid);
  const existing = gitlab.state.issues.get(key);
  if (!existing) throw new Error(`no remote issue ${iid}`);
  gitlab.state.issues.set(key, { ...existing, ...patch, updated_at: isoNow() });
}

beforeEach(async () => {
  harness = createHarness();
  userId = insertUser(harness, { username: 'syncuser' });
  projectId = createProject(harness, userId, 'GL');
  gitlab = await startFakeGitLab();

  const created = harness.services.gitlab.createConnection(
    projectId,
    {
      baseUrl: gitlab.url,
      accessToken: 'glpat-0123456789abcdefghij',
      gitlabProjectPath: 'team/project',
      syncMode: 'bidirectional',
      enabled: true,
      syncHierarchy: true,
      syncComments: true,
      syncLabels: true,
      syncIncidents: false,
      titlePrefix: '',
    },
    requestContext(userId, harness),
  );
  connectionId = (created as { id?: number }).id ?? 0;
  if (!connectionId) {
    connectionId = Number(
      harness.db.get<{ id: number }>(
        'SELECT id FROM gitlab_connections WHERE project_id = ?',
        [projectId],
      )?.id ?? 0,
    );
  }
});

afterEach(async () => {
  await new Promise<void>((resolve) => gitlab.server.close(() => resolve()));
  harness.close();
});

// ---------------------------------------------------------------------------

describe('connection configuration', () => {
  it('never returns the access token, only a hint', () => {
    const connection = harness.services.gitlab.getConnection(projectId);
    const serialised = JSON.stringify(connection);

    assert.ok(connection, 'the connection is readable');
    assert.ok(!serialised.includes('glpat-'), 'the token must never be serialised out');
    assert.equal(connection?.hasToken, true);
    assert.ok(connection?.tokenHint, 'a hint is provided so the right token can be confirmed');
  });

  it('stores the token encrypted at rest', () => {
    const row = harness.db.get<{ access_token_encrypted: string }>(
      'SELECT access_token_encrypted FROM gitlab_connections WHERE project_id = ?',
      [projectId],
    );
    assert.ok(row);
    assert.ok(!row?.access_token_encrypted.includes('glpat-'), 'the raw token is not in the database');
  });

});

describe('pushing local issues to GitLab', () => {
  it('creates the remote issue and records the linkage', async () => {
    const issue = await newIssue('Pushed on first sync');

    const run = await harness.services.gitlab.sync(connectionId, {
      direction: 'push',
      trigger: 'manual',
      actorId: userId,
    });

    assert.equal(run.status, 'ok', run.message ?? '');
    assert.equal(gitlab.state.issues.size, 1, 'exactly one issue was created remotely');

    const link = harness.db.get<{ external_id: string; sync_state: string }>(
      'SELECT external_id, sync_state FROM gitlab_external_links WHERE issue_id = ?',
      [issue.id],
    );
    assert.ok(link, 'the linkage is recorded so the next sync is not a duplicate');
    assert.equal(link?.sync_state, 'synced');
  });

  it('does not re-push an unchanged issue', async () => {
    await newIssue('Idempotent push');
    await harness.services.gitlab.sync(connectionId, { direction: 'push', trigger: 'manual', actorId: userId });

    const writesAfterFirst = gitlab.state.writes.length;
    const second = await harness.services.gitlab.sync(connectionId, {
      direction: 'push',
      trigger: 'manual',
      actorId: userId,
    });

    assert.equal(second.pushed, 0, 'nothing needed pushing');
    assert.equal(
      gitlab.state.writes.length,
      writesAfterFirst,
      'an unchanged issue must not be re-sent, or the mirror ping-pongs forever',
    );
  });

  it('pushes a locally edited issue', async () => {
    const issue = await newIssue('Will be edited');
    await harness.services.gitlab.sync(connectionId, { direction: 'push', trigger: 'manual', actorId: userId });

    harness.services.issues.update(issue.id, { title: 'Edited title' }, userId, {});
    const second = await harness.services.gitlab.sync(connectionId, {
      direction: 'push',
      trigger: 'manual',
      actorId: userId,
    });

    assert.ok(second.pushed >= 1, 'the edit is pushed');
    const remote = [...gitlab.state.issues.values()][0];
    assert.equal(remote?.title, 'Edited title');
  });
});

describe('pulling GitLab issues into the tracker', () => {
  it('imports a remote issue that has no local counterpart', async () => {
    const remote = seedRemoteIssue({ title: 'Reported directly in GitLab' });

    const run = await harness.services.gitlab.sync(connectionId, {
      direction: 'pull',
      trigger: 'manual',
      actorId: userId,
    });

    assert.equal(run.status, 'ok', run.message ?? '');
    assert.equal(run.pulled, 1);

    const local = harness.db.get<{ title: string; key: string }>(
      'SELECT title, key FROM issues WHERE project_id = ? ORDER BY id DESC LIMIT 1',
      [projectId],
    );
    assert.equal(local?.title, 'Reported directly in GitLab');
    assert.equal(remote.iid > 0, true);

    // The linkage points the imported issue back at the remote iid, which is
    // what stops a second pass importing it again.
    const link = harness.db.get<{ issue_id: number; external_id: string }>(
      `SELECT r.issue_id, r.external_id
       FROM gitlab_external_links r
       JOIN issues i ON i.id = r.issue_id
       WHERE i.project_id = ? AND i.title = ?`,
      [projectId, 'Reported directly in GitLab'],
    );
    assert.equal(link?.external_id, String(remote.iid));
  });

  it('does not re-import the same remote issue on a second pass', async () => {
    seedRemoteIssue({ title: 'Imported once' });
    await harness.services.gitlab.sync(connectionId, { direction: 'pull', trigger: 'manual', actorId: userId });
    const countAfterFirst = Number(
      harness.db.scalar<number>('SELECT COUNT(*) AS c FROM issues WHERE project_id = ?', [projectId]) ?? 0,
    );

    const second = await harness.services.gitlab.sync(connectionId, {
      direction: 'pull',
      trigger: 'manual',
      actorId: userId,
    });

    assert.equal(second.pulled, 0, 'nothing new to import');
    assert.equal(
      Number(harness.db.scalar<number>('SELECT COUNT(*) AS c FROM issues WHERE project_id = ?', [projectId]) ?? 0),
      countAfterFirst,
    );
  });
});

describe('source of truth', () => {
  it('bidirectional: the newer edit wins and the loser is recorded', async () => {
    const issue = await newIssue('Both sides will change');
    await harness.services.gitlab.sync(connectionId, { direction: 'push', trigger: 'manual', actorId: userId });
    const link = harness.db.get<{ external_id: string }>(
      'SELECT external_id FROM gitlab_external_links WHERE issue_id = ?',
      [issue.id],
    );
    const iid = Number(link?.external_id);

    // The remote is edited first, so it is strictly newer than the local row.
    editRemoteIssue(iid, { title: 'Remote wins by being newer' });

    const run = await harness.services.gitlab.sync(connectionId, {
      direction: 'full',
      trigger: 'manual',
      actorId: userId,
    });
    assert.equal(run.status, 'ok', run.message ?? '');

    const after = harness.services.issues.getById(issue.id);
    assert.equal(after.title, 'Remote wins by being newer', 'the newer side wins');
  });

  it('local_authoritative: the local value is kept and a conflict recorded', async () => {
    const issue = await newIssue('Tracker is canonical');
    await harness.services.gitlab.sync(connectionId, { direction: 'push', trigger: 'manual', actorId: userId });
    const link = harness.db.get<{ external_id: string }>(
      'SELECT external_id FROM gitlab_external_links WHERE issue_id = ?',
      [issue.id],
    );
    const iid = Number(link?.external_id);

    harness.services.gitlab.updateConnection(
      projectId,
      { syncMode: 'local_authoritative' },
      requestContext(userId, harness),
    );

    // Someone edits directly in GitLab; the tracker must not silently adopt it.
    editRemoteIssue(iid, { title: 'Changed behind the tracker back' });

    const run = await harness.services.gitlab.sync(connectionId, {
      direction: 'full',
      trigger: 'manual',
      actorId: userId,
    });
    assert.equal(run.status, 'ok', run.message ?? '');

    const after = harness.services.issues.getById(issue.id);
    assert.equal(after.title, 'Tracker is canonical', 'the canonical side wins');

    const conflicts = harness.services.gitlab.listConflicts(projectId, { unresolvedOnly: true });
    assert.ok(conflicts.length > 0, 'the discarded remote edit must be visible, not lost');
    const title = conflicts.find((conflict) => conflict.field === 'title');
    assert.ok(title, 'the title conflict is recorded');
    assert.match(String(title?.gitlabValue ?? ''), /Changed behind the tracker back/);
    assert.equal(title?.localValue, 'Tracker is canonical');
  });

  it('gitlab_authoritative: the remote value is applied and recorded', async () => {
    const issue = await newIssue('GitLab is canonical');
    await harness.services.gitlab.sync(connectionId, { direction: 'push', trigger: 'manual', actorId: userId });
    const link = harness.db.get<{ external_id: string }>(
      'SELECT external_id FROM gitlab_external_links WHERE issue_id = ?',
      [issue.id],
    );
    const iid = Number(link?.external_id);

    harness.services.gitlab.updateConnection(
      projectId,
      { syncMode: 'gitlab_authoritative' },
      requestContext(userId, harness),
    );

    editRemoteIssue(iid, { title: 'Canonical in GitLab' });
    await harness.services.gitlab.sync(connectionId, { direction: 'full', trigger: 'manual', actorId: userId });

    const after = harness.services.issues.getById(issue.id);
    assert.equal(after.title, 'Canonical in GitLab');
  });
});

describe('conflict resolution', () => {
  it('keeps the local value and re-pushes it', async () => {
    const issue = await newIssue('Resolve to local');
    await harness.services.gitlab.sync(connectionId, { direction: 'push', trigger: 'manual', actorId: userId });
    const link = harness.db.get<{ external_id: string }>(
      'SELECT external_id FROM gitlab_external_links WHERE issue_id = ?',
      [issue.id],
    );
    editRemoteIssue(Number(link?.external_id), { title: 'Remote variant' });

    harness.services.gitlab.updateConnection(
      projectId,
      { syncMode: 'local_authoritative' },
      requestContext(userId, harness),
    );
    await harness.services.gitlab.sync(connectionId, { direction: 'full', trigger: 'manual', actorId: userId });

    const conflicts = harness.services.gitlab.listConflicts(projectId, { unresolvedOnly: true });
    assert.ok(conflicts.length > 0, 'a conflict is recorded');
    const title = conflicts.find((conflict) => conflict.field === 'title') ?? conflicts[0];

    await harness.services.gitlab.resolveConflict(
      Number(title?.id),
      { resolution: 'kept_local' },
      requestContext(userId, harness),
    );

    const reopened = harness.services.gitlab
      .listConflicts(projectId, { unresolvedOnly: true })
      .find((conflict) => conflict.id === title?.id);
    assert.equal(reopened, undefined, 'the resolved conflict is closed');

    const resolved = harness.db.get<{ resolution: string }>(
      'SELECT resolution FROM gitlab_sync_conflicts WHERE id = ?',
      [title?.id],
    );
    assert.equal(resolved?.resolution, 'kept_local');
  });
});

describe('sync runs and status', () => {
  it('records a run with counts and a status', async () => {
    await newIssue('Counted run');
    const run = await harness.services.gitlab.sync(connectionId, {
      direction: 'full',
      trigger: 'manual',
      actorId: userId,
    });

    assert.equal(run.status, 'ok');
    assert.equal(run.pushed, 1);
    assert.ok(run.startedAt);

    const runs = harness.services.gitlab.listRuns(projectId, 10);
    assert.ok(runs.length > 0, 'the run is listed');
  });

  it('reports a failed sync without losing the linkage', async () => {
    await newIssue('Survives a failure');
    await harness.services.gitlab.sync(connectionId, { direction: 'push', trigger: 'manual', actorId: userId });

    gitlab.state.failNext = 99; // every subsequent request fails
    const run = await harness.services.gitlab.sync(connectionId, {
      direction: 'push',
      trigger: 'manual',
      actorId: userId,
    });

    assert.notEqual(run.status, 'ok', 'an unreachable remote is reported as a failure');
    assert.equal(harness.services.issues.getById(
      Number(
        harness.db.scalar<number>('SELECT id FROM issues WHERE project_id = ? ORDER BY id LIMIT 1', [projectId]) ?? 0,
      ),
    ).title, 'Survives a failure', 'the local issue is untouched by a failed push');
  });

  it('summarises connection health', async () => {
    await newIssue('Health check');
    await harness.services.gitlab.sync(connectionId, { direction: 'full', trigger: 'manual', actorId: userId });

    const status = harness.services.gitlab.status(projectId);
    assert.ok(status.connection, 'the connection is reported');
    assert.equal(status.connection?.syncMode, 'bidirectional');
    assert.equal(status.unresolvedConflicts, 0);
    assert.ok(status.lastRun, 'the last run is included');
  });

  it('refuses two concurrent syncs of the same connection', async () => {
    await newIssue('Concurrent');
    gitlab.state.failNext = 100; // slow the remote down so the first is still running

    const first = harness.services.gitlab.sync(connectionId, {
      direction: 'full',
      trigger: 'manual',
      actorId: userId,
    });
    const second = await harness.services.gitlab.sync(connectionId, {
      direction: 'full',
      trigger: 'manual',
      actorId: userId,
    }).then(
      () => 'completed' as const,
      () => 'refused' as const,
    );

    assert.equal(second, 'refused', 'a second concurrent sync is refused rather than interleaved');
    await first;
  });
});
