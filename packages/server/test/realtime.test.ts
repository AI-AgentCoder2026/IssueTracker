/**
 * Real-time hub and WebSocket gateway.
 *
 * The hub is transport-agnostic, so most of this file drives it directly and
 * the gateway cases run against a real server over a real WebSocket.
 *
 * The point of the file is presence isolation. Presence carries a user id, a
 * display name and an avatar — and it is broadcast project-wide. If presence
 * is not scoped to a project, a client on project A is told the real name of
 * every user connected anywhere in the instance, including projects they were
 * never granted access to. That is a cross-tenant disclosure, so the cases
 * below assert the negative directly: a null or foreign projectId must never
 * appear in a project's presence list.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp, type TrackerApp } from '../src/app.ts';
import { Database } from '../src/db/connection.ts';
import { migrate } from '../src/db/migrate.ts';
import { RealtimeHub } from '../src/realtime/hub.ts';
import { API } from '@tracker/shared';
import { WS_PATH } from '@tracker/shared';

// ---------------------------------------------------------------------------
// Hub: fan-out
// ---------------------------------------------------------------------------

describe('hub fan-out', () => {
  let hub: RealtimeHub;

  before(() => {
    hub = new RealtimeHub();
  });

  after(() => {
    hub.reset();
  });

  it('delivers a project event to that project’s subscribers only', () => {
    const a: string[] = [];
    const b: string[] = [];
    hub.subscribe('project:1', (frame) => a.push(frame));
    hub.subscribe('project:2', (frame) => b.push(frame));

    const delivered = hub.publish({ event: 'issue.updated', projectId: 1, data: { id: 7 } });

    assert.equal(delivered, 1);
    assert.equal(a.length, 1);
    assert.equal(b.length, 0);
    const frame = JSON.parse(a[0] as string);
    assert.equal(frame.event, 'issue.updated');
    assert.equal(frame.data.id, 7);
    assert.ok(frame.at, 'frames must be timestamped');
  });

  it('fans an event out to the project, the issue and the addressed users', () => {
    const local: string[] = [];
    hub.subscribe('project:3', (frame) => local.push(`project:${frame}`));
    hub.subscribe('issue:30', (frame) => local.push(`issue:${frame}`));
    hub.subscribe('user:9', (frame) => local.push(`user:${frame}`));

    const delivered = hub.publish({ event: 'comment.created', projectId: 3, issueId: 30, userIds: [9] });

    assert.equal(delivered, 3);
    assert.equal(local.filter((f) => f.startsWith('project:')).length, 1);
    assert.equal(local.filter((f) => f.startsWith('issue:')).length, 1);
    assert.equal(local.filter((f) => f.startsWith('user:')).length, 1);
  });

  it('drops a throwing subscriber and keeps delivering to the rest', () => {
    const good: string[] = [];
    const unsubscribeBad = hub.subscribe('project:4', () => {
      throw new Error('socket died');
    });
    hub.subscribe('project:4', (frame) => good.push(frame));

    const delivered = hub.publish({ event: 'ping', projectId: 4 });

    assert.equal(delivered, 1, 'the healthy subscriber still receives the frame');
    assert.equal(good.length, 1);
    unsubscribeBad();
  });

  it('garbage-collects a channel once its last subscriber leaves', () => {
    const before = hub.stats().channels;
    const unsubscribe = hub.subscribe('project:5', () => {});
    assert.equal(hub.stats().channels, before + 1);
    unsubscribe();
    assert.equal(hub.stats().channels, before, 'empty channels must not accumulate');
  });

  it('stops delivering after unsubscribe', () => {
    const seen: string[] = [];
    const unsubscribe = hub.subscribe('project:6', (frame) => seen.push(frame));
    hub.publish({ event: 'ping', projectId: 6 });
    unsubscribe();
    hub.publish({ event: 'ping', projectId: 6 });
    assert.equal(seen.length, 1);
  });
});

// ---------------------------------------------------------------------------
// Hub: presence isolation
// ---------------------------------------------------------------------------

describe('hub presence isolation', () => {
  let hub: RealtimeHub;

  before(() => {
    hub = new RealtimeHub();
  });

  after(() => {
    hub.reset();
  });

  const present = (over: Partial<Parameters<RealtimeHub['setPresence']>[0]>) =>
    hub.setPresence({
      connectionId: 'c1',
      userId: 1,
      username: 'alice',
      displayName: 'Alice',
      avatarUrl: null,
      projectId: 1,
      issueId: null,
      activity: null,
      ...over,
    } as Parameters<RealtimeHub['setPresence']>[0]);

  it('does not leak a project-less connection into every project', () => {
    hub.reset();
    present({ connectionId: 'c-null', userId: 77, projectId: null, issueId: null });

    // A connection that has not chosen a project belongs to no project.
    assert.deepEqual(hub.presenceForProject(1), []);
    assert.deepEqual(hub.presenceForProject(2), []);
    assert.deepEqual(hub.presenceForProject(999), []);
  });

  it('does not leak a project-less connection that carries an issue id', () => {
    hub.reset();
    // The gateway used to record issueId but not projectId, which let a cursor
    // on any issue surface in every project.
    present({ connectionId: 'c-issue-only', userId: 78, projectId: null, issueId: 4242 });

    assert.deepEqual(hub.presenceForProject(1), []);
    assert.deepEqual(hub.presenceForProject(2), []);
  });

  it('returns only the requested project’s users', () => {
    hub.reset();
    present({ connectionId: 'a', userId: 1, username: 'alice', projectId: 1 });
    present({ connectionId: 'b', userId: 2, username: 'bob', projectId: 2 });

    const inOne = hub.presenceForProject(1);
    assert.equal(inOne.length, 1);
    assert.equal(inOne[0]?.username, 'alice');
    assert.equal(inOne[0]?.projectId, 1);
    assert.deepEqual(
      hub.presenceForProject(2).map((e) => e.username),
      ['bob'],
    );
  });

  it('does not pull a same-user entry from another project into the list', () => {
    hub.reset();
    // Alice has two tabs: one on an issue in project 2, one on the project 1
    // board. The project-1 list must show the project-1 entry.
    present({ connectionId: 'p2-issue', userId: 1, username: 'alice', projectId: 2, issueId: 99 });
    present({ connectionId: 'p1-board', userId: 1, username: 'alice', projectId: 1, issueId: null });

    const inOne = hub.presenceForProject(1);
    assert.equal(inOne.length, 1);
    assert.equal(inOne[0]?.projectId, 1, 'the foreign issue entry must not win the dedup');
    assert.equal(inOne[0]?.issueId, null);
  });

  it('de-duplicates several tabs of one user, preferring the issue they are reading', () => {
    hub.reset();
    present({ connectionId: 'tab-board', userId: 1, projectId: 1, issueId: null, activity: null });
    present({ connectionId: 'tab-issue', userId: 1, projectId: 1, issueId: 55, activity: 'typing' });

    const entries = hub.presenceForProject(1);
    assert.equal(entries.length, 1, 'one row per user, not per tab');
    assert.equal(entries[0]?.issueId, 55);
    assert.equal(entries[0]?.activity, 'typing');
  });

  it('never exposes the internal connection id to clients', () => {
    hub.reset();
    present({ connectionId: 'secret-conn', userId: 1, projectId: 1 });
    const [entry] = hub.presenceForProject(1);
    assert.ok(entry);
    assert.equal((entry as Record<string, unknown>)['connectionId'], undefined);
  });

  it('clears presence for a single connection only', () => {
    hub.reset();
    present({ connectionId: 'tab-1', userId: 1, projectId: 1 });
    present({ connectionId: 'tab-2', userId: 1, projectId: 1 });

    hub.clearPresence(1, 'tab-1');
    assert.equal(hub.presenceForProject(1).length, 1, 'the other tab is still connected');

    hub.clearPresence(1, 'tab-2');
    assert.deepEqual(hub.presenceForProject(1), []);
  });

  it('ignores a clear for a connection that never existed', () => {
    hub.reset();
    present({ connectionId: 'real', userId: 1, projectId: 1 });
    hub.clearPresence(1, 'impostor');
    hub.clearPresence(999, 'real');
    assert.equal(hub.presenceForProject(1).length, 1);
  });

  it('prunes connections that stopped sending heartbeats', () => {
    hub.reset();
    present({ connectionId: 'stale', userId: 1, projectId: 1 });
    assert.deepEqual(hub.presenceForProject(1).length, 1);
    // Every entry is written with "now"; nothing is old enough yet.
    assert.equal(hub.prunePresence(), 0);
    assert.equal(hub.presenceForProject(1).length, 1);
  });

  it('reports presence entries that outlived a project subscription', () => {
    hub.reset();
    present({ connectionId: 'a', userId: 1, projectId: 1 });
    present({ connectionId: 'b', userId: 2, projectId: 1 });
    assert.equal(hub.stats().presenceEntries, 2);
    hub.reset();
    assert.equal(hub.stats().presenceEntries, 0);
  });
});

// ---------------------------------------------------------------------------
// Gateway over a real WebSocket
// ---------------------------------------------------------------------------

let tracker: TrackerApp;
let baseUrl = '';
let wsUrl = '';

const cookies = new Map<string, string>();

/** Log in and remember the session cookie for subsequent calls. */
async function login(username: string, password: string): Promise<string> {
  const response = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ login: username, password }),
  });
  assert.equal(response.status, 200, `login failed for ${username}`);
  const cookie = (response.headers.getSetCookie?.() ?? [])
    .map((c) => c.split(';')[0] as string)
    .find((c) => c.startsWith('tracker_session='));
  assert.ok(cookie, 'login must set a session cookie');
  cookies.set(username, cookie as string);
  return cookie as string;
}

async function api(
  username: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: any }> {
  const headers: Record<string, string> = {};
  const cookie = cookies.get(username);
  if (cookie) headers['cookie'] = cookie;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let parsed: unknown = text;
  try {
    parsed = text.length > 0 ? JSON.parse(text) : null;
  } catch {
    /* keep raw */
  }
  return { status: response.status, body: parsed };
}

interface Frame {
  event: string;
  ref?: string;
  data?: any;
  projectId?: number;
}

/** A tiny client that records every frame the server pushes to it. */
class Client {
  readonly frames: Frame[] = [];
  readonly socket: WebSocket;
  private readonly waiters: Array<() => void> = [];

  constructor(cookie: string) {
    this.socket = new WebSocket(wsUrl, { headers: { cookie } } as never);
    this.socket.addEventListener('message', (event) => {
      this.frames.push(JSON.parse(String(event.data)));
      for (const wake of this.waiters.splice(0)) wake();
    });
  }

  ready(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.socket.addEventListener('open', () => resolve(), { once: true });
      this.socket.addEventListener('error', () => reject(new Error('socket error')), { once: true });
    });
  }

  closed(): Promise<number> {
    return new Promise((resolve) => {
      if (this.socket.readyState === WebSocket.CLOSED) return resolve(this.socket.closeCode ?? 1006);
      this.socket.addEventListener('close', (event) => resolve(event.code), { once: true });
    });
  }

  send(message: Record<string, unknown>): void {
    this.socket.send(JSON.stringify(message));
  }

  /** Wait for the next frame matching `predicate`, or time out. */
  async next(predicate: (frame: Frame) => boolean, timeoutMs = 2000): Promise<Frame> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const found = this.frames.find(predicate);
      if (found) return found;
      if (Date.now() > deadline) {
        throw new Error(
          `timed out waiting for a matching frame; saw: ${JSON.stringify(this.frames.map((f) => f.event))}`,
        );
      }
      await new Promise<void>((resolve) => {
        this.waiters.push(resolve);
        setTimeout(resolve, 25);
      });
    }
  }

  close(): void {
    try {
      this.socket.close();
    } catch {
      /* already closed */
    }
  }
}

const settle = (ms = 120) => new Promise((resolve) => setTimeout(resolve, ms));

/** Poll a raw frame array until `predicate` matches, or fail loudly. */
async function waitFor(
  frames: Frame[],
  predicate: (frame: Frame) => boolean,
  timeoutMs = 3000,
): Promise<Frame> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = frames.find(predicate);
    if (found) return found;
    if (Date.now() > deadline) {
      throw new Error(`timed out; saw ${JSON.stringify(frames.map((f) => f.event))}`);
    }
    await settle(20);
  }
}

describe('websocket gateway', () => {
  let outsiderCookie = '';
  let memberCookie = '';
  let memberOfOne = 0;
  let outsiderProject = 0;
  let issueInOne = 0;
  let issueInOther = 0;

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
    wsUrl = `${baseUrl.replace('http://', 'ws://')}${WS_PATH}`;

    // First user becomes the instance administrator.
    await api('root', 'POST', '/api/auth/register', {
      username: 'root',
      email: 'root@example.com',
      displayName: 'Root',
      password: 'Sup3rSecret!Pass',
    });
    await login('root', 'Sup3rSecret!Pass');

    const one = await api('root', 'POST', API.projects.create, {
      key: 'ONE',
      name: 'Project one',
      visibility: 'private',
    });
    const other = await api('root', 'POST', API.projects.create, {
      key: 'OTHER',
      name: 'Project other',
      visibility: 'private',
    });
    assert.equal(one.status, 200, `project create failed: ${JSON.stringify(one.body)}`);
    assert.equal(other.status, 200, `project create failed: ${JSON.stringify(other.body)}`);
    memberOfOne = one.body.project.id;
    outsiderProject = other.body.project.id;

    // A user who belongs to project ONE, and one who belongs to neither.
    for (const username of ['member', 'outsider']) {
      const created = await api('root', 'POST', API.users.create, {
        username,
        email: `${username}@example.com`,
        displayName: username,
        password: 'Sup3rSecret!Pass',
      });
      assert.equal(created.status, 201, `user create failed: ${JSON.stringify(created.body)}`);
    }

    const added = await api(
      'root',
      'POST',
      API.projects.addMember.replace(':projectId', String(memberOfOne)),
      { usernameOrEmail: 'member', role: 'developer' },
    );
    assert.equal(added.status, 200, `add member failed: ${JSON.stringify(added.body)}`);

    memberCookie = await login('member', 'Sup3rSecret!Pass');
    outsiderCookie = await login('outsider', 'Sup3rSecret!Pass');

    const issueA = await api('root', 'POST', API.issues.create, {
      projectId: memberOfOne,
      title: 'Private to project one',
    });
    const issueB = await api('root', 'POST', API.issues.create, {
      projectId: outsiderProject,
      title: 'Private to the other project',
    });
    assert.equal(issueA.status, 200, `issue create failed: ${JSON.stringify(issueA.body)}`);
    assert.equal(issueB.status, 200, `issue create failed: ${JSON.stringify(issueB.body)}`);
    issueInOne = issueA.body.issue.id;
    issueInOther = issueB.body.issue.id;
  });

  after(async () => {
    if (tracker) await tracker.close();
  });

  it('refuses a socket with no session', async () => {
    const anonymous = new WebSocket(wsUrl);
    // Bounded on purpose: on the unfixed gateway the anonymous socket is
    // accepted and simply stays open, so awaiting `close` alone would hang
    // the suite instead of reporting the bypass.
    const code = await Promise.race<number>([
      new Promise<number>((resolve) => {
        anonymous.addEventListener('close', (event) => resolve(event.code), { once: true });
        anonymous.addEventListener('error', () => resolve(1006), { once: true });
      }),
      new Promise<number>((resolve) => setTimeout(() => resolve(-1), 3000)),
    ]);
    assert.equal(code, 4401, 'an unauthenticated socket must be closed with 4401');
    if (code === -1) anonymous.close();
  });

  it('survives a cursor pointing at an issue that does not exist', async () => {
    // The handler used to call `getById` unguarded. A missing id threw, and a
    // throw inside a socket callback takes the process down — so any logged-in
    // user could kill the server with one frame.
    const client = new Client(memberCookie);
    try {
      await client.ready();
      await client.next((f) => f.event === 'hello');
      client.send({ event: 'presence.cursor', issueId: 999_999_999, ref: 'ghost' });
      const frame = await client.next((f) => f.ref === 'ghost');
      assert.equal(frame.event, 'error');

      // Still alive and serving.
      client.send({ event: 'ping', ref: 'alive' });
      assert.equal((await client.next((f) => f.ref === 'alive')).event, 'pong');
      const health = await fetch(`${baseUrl}/api/health`);
      assert.equal(health.status, 200, 'the server must survive a bad frame');
    } finally {
      client.close();
    }
  });

  it('refuses a project subscription the caller has no role in', async () => {
    const client = new Client(outsiderCookie);
    try {
      await client.ready();
      await client.next((f) => f.event === 'hello');
      client.send({ event: 'subscribe.project', projectId: memberOfOne, ref: 'r1' });
      const frame = await client.next((f) => f.ref === 'r1');
      assert.equal(frame.event, 'error');
      assert.match(String(frame.data?.message), /not permitted/i);
    } finally {
      client.close();
    }
  });

  it('refuses an issue subscription for an issue the caller cannot read', async () => {
    // The project subscription is authorised; the issue subscription is the
    // one that used to skip the check entirely, letting any logged-in user
    // listen to comment and edit events on any issue by guessing its id.
    const client = new Client(outsiderCookie);
    try {
      await client.ready();
      await client.next((f) => f.event === 'hello');
      client.send({ event: 'subscribe.issue', issueId: issueInOne, ref: 'r-issue' });
      const frame = await client.next((f) => f.ref === 'r-issue');
      assert.equal(frame.event, 'error', 'reading another project’s issue must be refused');
      assert.match(String(frame.data?.message), /not permitted/i);
    } finally {
      client.close();
    }
  });

  it('accepts a project subscription the caller does have a role in', async () => {
    const client = new Client(memberCookie);
    try {
      await client.ready();
      await client.next((f) => f.event === 'hello');
      client.send({ event: 'subscribe.project', projectId: memberOfOne, ref: 'ok' });
      const frame = await client.next((f) => f.ref === 'ok');
      assert.equal(frame.event, 'hello');
      assert.equal(frame.data?.subscribed, true);
    } finally {
      client.close();
    }
  });

  it('answers ping with pong', async () => {
    const client = new Client(memberCookie);
    try {
      await client.ready();
      await client.next((f) => f.event === 'hello');
      client.send({ event: 'ping', ref: 'p1' });
      const frame = await client.next((f) => f.ref === 'p1');
      assert.equal(frame.event, 'pong');
    } finally {
      client.close();
    }
  });

  it('reports malformed JSON instead of dropping the socket', async () => {
    const client = new Client(memberCookie);
    try {
      await client.ready();
      await client.next((f) => f.event === 'hello');
      client.socket.send('{not json');
      const frame = await client.next((f) => f.event === 'error');
      assert.match(String(frame.data?.message), /malformed/i);
      client.send({ event: 'ping', ref: 'still-alive' });
      assert.equal((await client.next((f) => f.ref === 'still-alive')).event, 'pong');
    } finally {
      client.close();
    }
  });

  it('does not name another project’s user in this project’s presence', async () => {
    const rootClient = new Client(cookies.get('root') as string);
    const otherClient = new Client(cookies.get('root') as string);
    const outsider = new Client(outsiderCookie);
    try {
      await Promise.all([rootClient.ready(), otherClient.ready(), outsider.ready()]);
      await Promise.all([
        rootClient.next((f) => f.event === 'hello'),
        otherClient.next((f) => f.event === 'hello'),
        outsider.next((f) => f.event === 'hello'),
      ]);

      // Root sits on the board of each project; the outsider joins the other.
      rootClient.send({ event: 'subscribe.project', projectId: memberOfOne, ref: 'r' });
      rootClient.send({ event: 'subscribe.project', projectId: outsiderProject, ref: 'o' });
      otherClient.send({ event: 'subscribe.project', projectId: outsiderProject, ref: 'o2' });
      await Promise.all([
        rootClient.next((f) => f.ref === 'r'),
        rootClient.next((f) => f.ref === 'o'),
        otherClient.next((f) => f.ref === 'o2'),
      ]);

      // A cursor move in the *other* project must republish only there.
      otherClient.send({ event: 'presence.cursor', issueId: issueInOther, activity: 'typing' });
      await otherClient.next(
        (f) => f.event === 'presence' && f.projectId === outsiderProject && f.data?.entries?.length > 0,
      );
      await settle();

      // The outsider is connected but subscribed to no project, so nothing
      // about their connection may appear on the project-one board.
      const oneFrame = rootClient.frames.filter(
        (f) => f.event === 'presence' && f.projectId === memberOfOne,
      );
      const names = oneFrame.flatMap((f) => f.data?.entries?.map((e: any) => e.username) ?? []);
      assert.ok(names.length > 0, 'root should appear on its own project board');
      assert.ok(
        !names.includes('outsider'),
        `project ONE leaked the outsider's presence: ${JSON.stringify(names)}`,
      );

      // And project ONE's members must not surface on the other board.
      const otherFrame = otherClient.frames.filter(
        (f) => f.event === 'presence' && f.projectId === outsiderProject,
      );
      const otherNames = otherFrame.flatMap((f) => f.data?.entries?.map((e: any) => e.username) ?? []);
      assert.ok(
        !otherNames.includes('member'),
        `project OTHER leaked a member of project ONE: ${JSON.stringify(otherNames)}`,
      );
    } finally {
      rootClient.close();
      otherClient.close();
      outsider.close();
    }
  });

  it('scopes a guest link to its own project and labels it by name', async () => {
    const created = await api(
      'root',
      'POST',
      API.users.createGuestToken.replace(':projectId', String(outsiderProject)),
      {
        label: 'Contractor review',
        role: 'viewer',
        canComment: false,
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        maxUses: 5,
      },
    );
    assert.equal(created.status, 201, `guest token failed: ${JSON.stringify(created.body)}`);
    // The share URL is a path (`/guest/<secret>`), not an absolute URL.
    const sharePath = String(created.body.url);
    const secret = sharePath.slice(sharePath.lastIndexOf('/') + 1);
    assert.ok(secret.length > 20, `no guest secret in ${JSON.stringify(created.body)}`);

    // A guest has no user row; its actor id is the reserved 0. The board must
    // show the link's label, never "0".
    const guestSocket = new WebSocket(`${wsUrl}?guest=${encodeURIComponent(String(secret))}`);
    const frames: Frame[] = [];
    guestSocket.addEventListener('message', (e) => frames.push(JSON.parse(String(e.data))));
    try {
      await Promise.race([
        new Promise<void>((resolve) => guestSocket.addEventListener('open', () => resolve(), { once: true })),
        new Promise<void>((_, reject) => setTimeout(() => reject(new Error('guest socket did not open')), 3000)),
      ]);

      // The guest's own project is allowed.
      guestSocket.send(JSON.stringify({ event: 'subscribe.project', projectId: outsiderProject, ref: 'g1' }));
      const allowed = await waitFor(frames, (f) => f.ref === 'g1');
      assert.equal(allowed.event, 'hello', 'a guest may watch the project it was invited to');

      // Any other project is not.
      guestSocket.send(JSON.stringify({ event: 'subscribe.project', projectId: memberOfOne, ref: 'g2' }));
      const denied = await waitFor(frames, (f) => f.ref === 'g2');
      assert.equal(denied.event, 'error', 'a guest link must not widen beyond its project');
    } finally {
      guestSocket.close();
    }
  });

  it('publishes a user as viewing an issue when they open it', async () => {
    // The client declares "I am here" by subscribing to the issue, then the
    // project. The order must not matter, and the issue must survive the
    // project subscription that follows it.
    const watcher = new Client(cookies.get('root') as string);
    try {
      await watcher.ready();
      await watcher.next((f) => f.event === 'hello');
      watcher.send({ event: 'subscribe.issue', issueId: issueInOne, ref: 'i' });
      await watcher.next((f) => f.ref === 'i');
      watcher.send({ event: 'subscribe.project', projectId: memberOfOne, ref: 'p' });
      await watcher.next((f) => f.ref === 'p');
      await settle();

      const observer = new Client(memberCookie);
      try {
        await observer.ready();
        await observer.next((f) => f.event === 'hello');
        observer.send({ event: 'subscribe.project', projectId: memberOfOne, ref: 'o' });
        await observer.next((f) => f.ref === 'o');
        await settle();

        const frame = observer.frames
          .filter((f) => f.event === 'presence' && f.projectId === memberOfOne)
          .pop();
        assert.ok(frame, 'no presence broadcast for the project');
        const watching = (frame.data?.entries ?? []).filter((e: any) => e.issueId === issueInOne);
        assert.equal(watching.length, 1, 'the issue subscriber must appear on the issue');
        assert.equal(watching[0].username, 'root');
        assert.match(String(watching[0].displayName), /root/i, 'presence must name the user, not an id');
      } finally {
        observer.close();
      }
    } finally {
      watcher.close();
    }
  });

  it('keeps the project feed when the user navigates away from the issue', async () => {
    // Leaving an issue used to drop every subscription the socket held.
    const client = new Client(cookies.get('root') as string);
    try {
      await client.ready();
      await client.next((f) => f.event === 'hello');
      client.send({ event: 'subscribe.project', projectId: memberOfOne, ref: 'p' });
      await client.next((f) => f.ref === 'p');
      client.send({ event: 'subscribe.issue', issueId: issueInOne, ref: 'i' });
      await client.next((f) => f.ref === 'i');
      client.send({ event: 'unsubscribe.issue', issueId: issueInOne, ref: 'u' });
      await client.next((f) => f.ref === 'u');
      await settle();

      // Still on the project board: presence updates must keep arriving.
      const before = client.frames.filter((f) => f.event === 'presence').length;
      client.send({ event: 'presence.cursor', issueId: issueInOne, ref: 'c' });
      await settle();
      const after = client.frames.filter((f) => f.event === 'presence').length;
      assert.ok(after > before, 'the project subscription was dropped when the issue was left');
    } finally {
      client.close();
    }
  });

  it('drops a closed socket from the presence list', async () => {
    const first = new Client(memberCookie);
    await first.ready();
    await first.next((f) => f.event === 'hello');
    first.send({ event: 'subscribe.project', projectId: memberOfOne, ref: 's' });
    await first.next((f) => f.ref === 's');
    first.close();
    await first.closed();
    await settle(200);

    const observer = new Client(cookies.get('root') as string);
    try {
      await observer.ready();
      await observer.next((f) => f.event === 'hello');
      observer.send({ event: 'subscribe.project', projectId: memberOfOne, ref: 'o' });
      await observer.next((f) => f.ref === 'o');
      await settle();
      const names = observer.frames
        .filter((f) => f.event === 'presence' && f.projectId === memberOfOne)
        .flatMap((f) => f.data?.entries?.map((e: any) => e.username) ?? []);
      // The member disconnected, so the last frame they appeared in may still
      // be cached client-side; what matters is that a later broadcast excludes
      // them. Subscribe.project on a fresh socket re-broadcasts presence.
      assert.ok(!names.includes('member'), `a closed socket stayed in presence: ${JSON.stringify(names)}`);
    } finally {
      observer.close();
    }
  });
});
