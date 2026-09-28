/**
 * WebSocket gateway.
 *
 * Bridges browsers to the `RealtimeHub`. Protocol:
 *
 *   client -> server  { event: 'subscribe.project', projectId, ref? }
 *                      { event: 'subscribe.issue', issueId, ref? }
 *                      { event: 'presence.cursor', issueId, activity? }
 *                      { event: 'ping' }
 *   server -> client  { event: 'hello' | 'presence' | 'issue.updated' | ... }
 *
 * Authentication happens during the upgrade request, reusing the same session
 * cookie and bearer token logic as the HTTP layer, so a socket is never more
 * privileged than the request that opened it.
 */

import { WS_PATH, type ClientEvent, type ServerMessage } from '@tracker/shared';
import type { FastifyInstance } from 'fastify';
import type { RealtimeHub } from './hub.ts';
import { requirePermission } from '../plugins/auth.plugin.ts';
import type { RequestContext } from '../services/context.ts';

interface Connection {
  id: string;
  userId: number;
  username: string;
  displayName: string;
  avatarUrl: string | null;
  /** Project this socket is scoped to, or null before it subscribes. */
  projectId: number | null;
  /** Issue this socket is reading, or null. */
  issueId: number | null;
  /** Last declared activity, replayed when a subscription re-scopes. */
  activity: string | null;
  /**
   * Project and issue subscriptions are torn down independently: leaving an
   * issue must not silently drop the project board feed, and vice versa.
   */
  projectUnsubscribers: Array<() => void>;
  issueUnsubscribers: Array<() => void>;
  socket: { send: (data: string) => void; close: () => void };
}

export function registerRealtimeGateway(app: FastifyInstance, hub: RealtimeHub): void {
  const connections = new Map<string, Connection>();
  let counter = 0;

  const send = (connection: Connection, message: ServerMessage): void => {
    try {
      connection.socket.send(JSON.stringify(message));
    } catch {
      connections.delete(connection.id);
    }
  };

  app.get(WS_PATH, { websocket: true }, (socket, request) => {
    // `request.context.actor` is always populated: the auth plugin substitutes
    // a grant-nothing anonymous actor so public routes keep a total context.
    // Only `request.actor` is null when there is no real principal, and it is
    // the one that means "authenticated". Testing the context instead of the
    // principal admitted every anonymous socket as user 0.
    const principal = request.actor;
    if (!principal) {
      socket.close(4401, 'Authentication required');
      return;
    }
    const context = request.context as RequestContext;

    // `Actor` is an authorisation projection and carries no profile fields, so
    // the display name is read from the user row. Presence is broadcast to
    // other people, so it should say who someone is rather than print their
    // internal id. A guest has no user row; it has a label the share link gave
    // it, and its synthetic id 0 must never be what a board shows.
    const guest = context.guest;
    const profile = guest ? null : context.services.auth.getUser(Number(principal.userId));
    const displayName = profile?.displayName ?? profile?.username ?? guest?.label ?? String(principal.userId);

    counter += 1;
    const connection: Connection = {
      id: `c${counter}-${Date.now()}`,
      userId: Number(principal.userId),
      username: profile?.username ?? guest?.label ?? String(principal.userId),
      displayName,
      avatarUrl: profile?.avatarUrl ?? null,
      projectId: null,
      issueId: null,
      activity: null,
      projectUnsubscribers: [],
      issueUnsubscribers: [],
      socket,
    };
    connections.set(connection.id, connection);

    /**
     * Re-record this connection's presence. `projectId` stays null until the
     * client subscribes to a project or focuses an issue: presence is
     * broadcast per project, so a socket that has not chosen anywhere must
     * appear in no project's list rather than in all of them.
     */
    const recordPresence = (patch: {
      projectId?: number | null;
      issueId?: number | null;
      activity?: string | null;
    }): void => {
      if (patch.projectId !== undefined) connection.projectId = patch.projectId;
      if (patch.issueId !== undefined) connection.issueId = patch.issueId;
      if (patch.activity !== undefined) connection.activity = patch.activity;
      hub.setPresence({
        connectionId: connection.id,
        userId: connection.userId,
        username: connection.username,
        displayName: connection.displayName,
        avatarUrl: connection.avatarUrl,
        projectId: connection.projectId,
        issueId: connection.issueId,
        activity: connection.activity,
      });
    };

    recordPresence({});

    send(connection, {
      event: 'hello',
      ref: undefined,
      at: new Date().toISOString(),
      data: { connectionId: connection.id, userId: connection.userId },
    });

    const broadcastPresence = (projectId: number | null): void => {
      if (projectId === null) return;
      hub.publish({
        event: 'presence',
        projectId,
        data: { projectId, entries: hub.presenceForProject(projectId) },
      });
    };

    /**
     * Resolve an issue the caller may read, or null.
     *
     * Both failure modes are expected input here, not exceptional: an id that
     * does not exist throws from the service, and a real id in a project the
     * caller has no role in fails the permission check. Neither may propagate
     * — this runs inside a socket handler, where an uncaught error terminates
     * the process.
     */
    const readableIssue = (issueId: number): { projectId: number } | null => {
      let projectId: number;
      try {
        projectId = Number(context.services.issues.getById(issueId).projectId);
      } catch {
        return null;
      }
      try {
        requirePermission(request, 'issue.read', projectId);
      } catch {
        return null;
      }
      return { projectId };
    };

    socket.on('message', (raw: Buffer | string) => {
      let parsed: { event?: ClientEvent; ref?: string; projectId?: number; issueId?: number; activity?: string };
      try {
        parsed = JSON.parse(typeof raw === 'string' ? raw : raw.toString('utf8')) as typeof parsed;
      } catch {
        send(connection, { event: 'error', data: { message: 'Malformed JSON' } });
        return;
      }

      // Any handler that throws would escape into the socket callback and
      // terminate the process, so the whole dispatch is guarded. A bad frame
      // must cost the sender one error, not the whole instance.
      try {
        switch (parsed.event) {
          case 'subscribe.project': {
            if (parsed.projectId === undefined) {
              send(connection, { event: 'error', ref: parsed.ref, data: { message: 'projectId is required' } });
              return;
            }
            try {
              // Re-check permission at subscribe time: membership may have been
              // revoked since the socket opened.
              requirePermission(request, 'issue.read', parsed.projectId);
            } catch {
              send(connection, {
                event: 'error',
                ref: parsed.ref,
                data: { message: 'Not permitted to subscribe to this project' },
              });
              return;
            }

            // Leaving a different project first, so a socket that switches
            // boards does not linger in the old one's presence list.
            if (connection.projectId !== null && connection.projectId !== parsed.projectId) {
              for (const unsubscribe of connection.projectUnsubscribers.splice(0)) unsubscribe();
              broadcastPresence(connection.projectId);
            }
            connection.projectUnsubscribers.push(
              hub.subscribe(`project:${parsed.projectId}`, (frame) => {
                try {
                  socket.send(frame);
                } catch {
                  connections.delete(connection.id);
                }
              }),
            );
            connection.projectUnsubscribers.push(
              hub.subscribe(`user:${connection.userId}`, (frame) => {
                try {
                  socket.send(frame);
                } catch {
                  connections.delete(connection.id);
                }
              }),
            );

            // Now that we know where this user is, scope their presence to it.
            // An issue already open in this same project is kept: a client
            // subscribes to the project and then to the issue it is reading,
            // and the board subscription must not erase the issue one.
            const sameProject = connection.projectId === parsed.projectId;
            recordPresence({
              projectId: parsed.projectId,
              issueId: sameProject ? connection.issueId : null,
              activity: sameProject ? connection.activity : null,
            });

            send(connection, { event: 'hello', ref: parsed.ref, projectId: parsed.projectId, data: { subscribed: true } });
            broadcastPresence(parsed.projectId);
            return;
          }

          case 'subscribe.issue': {
            if (parsed.issueId === undefined) {
              send(connection, { event: 'error', ref: parsed.ref, data: { message: 'issueId is required' } });
              return;
            }
            // Issue channels carry comment bodies and edit events, so being
            // logged in is not enough: an unauthenticated guess at an id must
            // not buy a seat on a project the caller was never granted.
            const issue = readableIssue(parsed.issueId);
            if (!issue) {
              send(connection, {
                event: 'error',
                ref: parsed.ref,
                data: { message: 'Not permitted to subscribe to this issue' },
              });
              return;
            }
            for (const unsubscribe of connection.issueUnsubscribers.splice(0)) unsubscribe();
            connection.issueUnsubscribers.push(
              hub.subscribe(`issue:${parsed.issueId}`, (frame) => {
                try {
                  socket.send(frame);
                } catch {
                  connections.delete(connection.id);
                }
              }),
            );

            // Opening an issue is also how the client says "I am here", so this
            // is where presence gets scoped. Skipping it is why the issue page's
            // "who else is viewing" indicator used to stay empty.
            const previousProject = connection.projectId;
            recordPresence({
              projectId: issue.projectId,
              issueId: parsed.issueId,
              activity: parsed.activity ?? null,
            });

            send(connection, { event: 'hello', ref: parsed.ref, issueId: parsed.issueId, data: { subscribed: true } });
            broadcastPresence(issue.projectId);
            if (previousProject !== null && previousProject !== issue.projectId) {
              broadcastPresence(previousProject);
            }
            return;
          }

          case 'unsubscribe.project': {
            if (parsed.projectId === undefined) return;
            const previous = connection.projectId;
            for (const unsubscribe of connection.projectUnsubscribers.splice(0)) unsubscribe();
            // Issue subscriptions survive leaving a board: the client may still
            // be reading an issue it was sent to directly.
            recordPresence({ issueId: null, activity: null });
            if (previous !== null && previous !== parsed.projectId) {
              connection.projectId = null;
              hub.clearPresence(connection.userId, connection.id);
              broadcastPresence(previous);
            }
            send(connection, { event: 'hello', ref: parsed.ref, data: { unsubscribed: true } });
            return;
          }

          case 'unsubscribe.issue': {
            const previous = connection.projectId;
            for (const unsubscribe of connection.issueUnsubscribers.splice(0)) unsubscribe();
            recordPresence({ issueId: null, activity: null });
            broadcastPresence(previous);
            send(connection, { event: 'hello', ref: parsed.ref, data: { unsubscribed: true } });
            return;
          }

          case 'presence.cursor': {
            // A heartbeat that names no issue keeps the connection alive without
            // moving it.
            if (parsed.issueId === undefined) {
              recordPresence({ activity: parsed.activity ?? null });
              return;
            }
            const issue = readableIssue(parsed.issueId);
            if (!issue) {
              send(connection, {
                event: 'error',
                ref: parsed.ref,
                data: { message: 'Not permitted to view this issue' },
              });
              return;
            }
            const previousProject = connection.projectId;
            recordPresence({
              projectId: issue.projectId,
              issueId: parsed.issueId,
              activity: parsed.activity ?? null,
            });
            broadcastPresence(issue.projectId);
            if (previousProject !== null && previousProject !== issue.projectId) {
              // Moving between projects must also update the board left behind.
              broadcastPresence(previousProject);
            }
            return;
          }

          case 'ping':
            send(connection, { event: 'pong', ref: parsed.ref, at: new Date().toISOString() });
            return;

          default:
            send(connection, { event: 'error', ref: parsed.ref, data: { message: 'Unknown event' } });
        }
      } catch (error) {
        request.log?.error?.({ err: error, ref: parsed?.ref }, 'websocket handler failed');
        send(connection, {
          event: 'error',
          ref: parsed?.ref,
          data: { message: 'Could not handle that message' },
        });
      }
    });

    const teardown = (): void => {
      for (const unsubscribe of connection.projectUnsubscribers.splice(0)) unsubscribe();
      for (const unsubscribe of connection.issueUnsubscribers.splice(0)) unsubscribe();
      hub.clearPresence(connection.userId, connection.id);
      connections.delete(connection.id);
    };

    socket.on('close', teardown);
    socket.on('error', teardown);
  });

  // Housekeeping: drop sockets that died without a close event, and stale
  // presence entries. Runs on the same interval the scheduler uses.
  const cleanup = setInterval(() => {
    hub.prunePresence();
  }, 30_000);
  cleanup.unref?.();

  app.addHook('onClose', async () => {
    clearInterval(cleanup);
    for (const connection of connections.values()) {
      try {
        connection.socket.close();
      } catch {
        // Already gone.
      }
    }
    connections.clear();
  });
}
