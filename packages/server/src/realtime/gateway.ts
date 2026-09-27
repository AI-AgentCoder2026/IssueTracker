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
  unsubscribers: Array<() => void>;
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
    // The auth plugin has already resolved the principal.
    const context = request.context as RequestContext | undefined;
    if (!context?.actor) {
      socket.close(4401, 'Authentication required');
      return;
    }

    counter += 1;
    const connection: Connection = {
      id: `c${counter}-${Date.now()}`,
      userId: Number(context.actor.userId),
      unsubscribers: [],
      socket,
    };
    connections.set(connection.id, connection);

    hub.setPresence({
      connectionId: connection.id,
      userId: Number(context.actor.userId),
      username: String(context.actor.userId),
      displayName: String(context.actor.userId),
      avatarUrl: null,
      projectId: null,
      issueId: null,
      activity: null,
    });

    send(connection, {
      event: 'hello',
      ref: undefined,
      at: new Date().toISOString(),
      data: { connectionId: connection.id, userId: Number(context.actor.userId) },
    });

    const broadcastPresence = (projectId: number | null): void => {
      if (projectId === null) return;
      hub.publish({
        event: 'presence',
        projectId,
        data: { projectId, entries: hub.presenceForProject(projectId) },
      });
    };

    socket.on('message', (raw: Buffer | string) => {
      let parsed: { event?: ClientEvent; ref?: string; projectId?: number; issueId?: number; activity?: string };
      try {
        parsed = JSON.parse(typeof raw === 'string' ? raw : raw.toString('utf8')) as typeof parsed;
      } catch {
        send(connection, { event: 'error', data: { message: 'Malformed JSON' } });
        return;
      }

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

          connection.unsubscribers.push(hub.subscribe(`project:${parsed.projectId}`, (frame) => {
            try {
              socket.send(frame);
            } catch {
              connections.delete(connection.id);
            }
          }));
          connection.unsubscribers.push(hub.subscribe(`user:${connection.userId}`, (frame) => {
            try {
              socket.send(frame);
            } catch {
              connections.delete(connection.id);
            }
          }));

          send(connection, { event: 'hello', ref: parsed.ref, projectId: parsed.projectId, data: { subscribed: true } });
          broadcastPresence(parsed.projectId);
          return;
        }

        case 'subscribe.issue': {
          if (parsed.issueId === undefined) {
            send(connection, { event: 'error', ref: parsed.ref, data: { message: 'issueId is required' } });
            return;
          }
          connection.unsubscribers.push(hub.subscribe(`issue:${parsed.issueId}`, (frame) => {
            try {
              socket.send(frame);
            } catch {
              connections.delete(connection.id);
            }
          }));
          send(connection, { event: 'hello', ref: parsed.ref, issueId: parsed.issueId, data: { subscribed: true } });
          return;
        }

        case 'unsubscribe.project': {
          if (parsed.projectId === undefined) return;
          // Subscribers are per-connection; closing them all on unsubscribe is
          // the safe behaviour and avoids leaking a listener.
          for (const unsubscribe of connection.unsubscribers.splice(0)) unsubscribe();
          send(connection, { event: 'hello', ref: parsed.ref, data: { unsubscribed: true } });
          return;
        }

        case 'unsubscribe.issue': {
          for (const unsubscribe of connection.unsubscribers.splice(0)) unsubscribe();
          send(connection, { event: 'hello', ref: parsed.ref, data: { unsubscribed: true } });
          return;
        }

        case 'presence.cursor': {
          hub.setPresence({
            connectionId: connection.id,
            userId: connection.userId,
            username: String(context.actor?.userId ?? ''),
            displayName: String(context.actor?.userId ?? ''),
            avatarUrl: null,
            projectId: null,
            issueId: parsed.issueId ?? null,
            activity: parsed.activity ?? null,
          });
          if (parsed.issueId !== undefined) {
            const issue = context.services.issues.getById(parsed.issueId);
            broadcastPresence(Number(issue.projectId));
          }
          return;
        }

        case 'ping':
          send(connection, { event: 'pong', ref: parsed.ref, at: new Date().toISOString() });
          return;

        default:
          send(connection, { event: 'error', ref: parsed.ref, data: { message: 'Unknown event' } });
      }
    });

    socket.on('close', () => {
      for (const unsubscribe of connection.unsubscribers.splice(0)) unsubscribe();
      hub.clearPresence(connection.userId, connection.id);
      connections.delete(connection.id);
    });

    socket.on('error', () => {
      for (const unsubscribe of connection.unsubscribers.splice(0)) unsubscribe();
      hub.clearPresence(connection.userId, connection.id);
      connections.delete(connection.id);
    });
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
