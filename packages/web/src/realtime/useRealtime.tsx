/**
 * WebSocket client.
 *
 * One socket is shared by the whole app. It reconnects with exponential backoff
 * plus jitter, re-sends every active subscription on reconnect, heartbeats on the
 * shared `PRESENCE_HEARTBEAT_MS` interval, and keeps the latest `presence`
 * payload per issue so the detail page can render "who else is here".
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { getSessionId } from '../api/client';
import { asArray, asRecord, isRecord, num, str, strOrNull } from '../api/normalize';
import {
  PRESENCE_HEARTBEAT_MS,
  WS_PATH,
  asIssueId,
  asProjectId,
  asUserId,
  type ClientMessage,
  type IssueId,
  type PresenceEntry,
  type ProjectId,
  type ServerEvent,
  type ServerMessage,
} from '../api/types';

export type RealtimeStatus = 'connecting' | 'open' | 'reconnecting' | 'closed';

export interface RealtimeValue {
  status: RealtimeStatus;
  /** Subscribe to a server event; returns an unsubscribe function. */
  subscribe: (event: ServerEvent, handler: (message: ServerMessage) => void) => () => void;
  /** Joins `project:<id>` so board/dashboard events arrive; returns a leave fn. */
  subscribeProject: (projectId: ProjectId) => () => void;
  /** Others currently viewing an issue. */
  presenceFor: (issueId: IssueId | null) => PresenceEntry[];
  /** Declares this client is viewing `issueId` so peers see the indicator. */
  setWatching: (issueId: IssueId | null, activity?: string | null) => void;
  /** Reconnects immediately; used by the "connection lost" affordance. */
  reconnect: () => void;
}

const RealtimeContext = createContext<RealtimeValue | null>(null);

const MAX_BACKOFF_MS = 20_000;

function toPresence(value: unknown): PresenceEntry {
  const r = asRecord(value);
  return {
    userId: asUserId(num(r.userId)),
    username: str(r.username),
    displayName: str(r.displayName, str(r.username, 'Unknown')),
    avatarUrl: strOrNull(r.avatarUrl),
    projectId:
      r.projectId === null || r.projectId === undefined ? null : asProjectId(num(r.projectId)),
    issueId: r.issueId === null || r.issueId === undefined ? null : asIssueId(num(r.issueId)),
    lastSeenAt: str(r.lastSeenAt),
    activity: strOrNull(r.activity),
  };
}

interface SocketState {
  url: string;
  /** Subscriptions to replay after a reconnect, keyed by their client message. */
  channels: Set<string>;
  presence: Map<string, PresenceEntry[]>;
}

export function RealtimeProvider({
  children,
  enabled,
}: {
  children: ReactNode;
  enabled: boolean;
}): JSX.Element {
  const [status, setStatus] = useState<RealtimeStatus>('closed');
  const [presenceVersion, setPresenceVersion] = useState(0);

  const socketRef = useRef<WebSocket | null>(null);
  const handlersRef = useRef(new Map<ServerEvent, Set<(message: ServerMessage) => void>>());
  const stateRef = useRef<SocketState>({ url: '', channels: new Set(), presence: new Map() });
  const attemptsRef = useRef(0);
  const reconnectTimer = useRef<number | null>(null);
  const heartbeatRef = useRef<number | null>(null);
  const watchingRef = useRef<{ issueId: IssueId; activity: string | null } | null>(null);

  const send = useCallback((message: ClientMessage) => {
    const socket = socketRef.current;
    if (socket === null || socket.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify(message));
  }, []);

  const closeSocket = useCallback(() => {
    if (heartbeatRef.current !== null) {
      window.clearInterval(heartbeatRef.current);
      heartbeatRef.current = null;
    }
    if (reconnectTimer.current !== null) {
      window.clearTimeout(reconnectTimer.current);
      reconnectTimer.current = null;
    }
    const socket = socketRef.current;
    socketRef.current = null;
    if (socket !== null) {
      socket.onopen = null;
      socket.onclose = null;
      socket.onerror = null;
      socket.onmessage = null;
      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
        socket.close(1000, 'client disconnect');
      }
    }
  }, []);

  const connect = useCallback(() => {
    if (!enabled) return;
    closeSocket();

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = `${protocol}//${window.location.host}${WS_PATH}`;
    stateRef.current.url = url;

    const session = getSessionId();
    // The socket is a first-party connection, so the httpOnly cookie travels
    // with the upgrade request; the query token covers proxy setups that strip it.
    const target = session === null ? url : `${url}?token=${encodeURIComponent(session)}`;
    setStatus(attemptsRef.current === 0 ? 'connecting' : 'reconnecting');

    const socket = new WebSocket(target);
    socketRef.current = socket;

    socket.onopen = () => {
      attemptsRef.current = 0;
      setStatus('open');
      for (const key of stateRef.current.channels) {
        const message = keyToMessage(key);
        if (message !== null) socket.send(JSON.stringify(message));
      }
      const watching = watchingRef.current;
      if (watching !== null) {
        socket.send(
          JSON.stringify({
            event: 'subscribe.issue',
            issueId: watching.issueId,
            activity: watching.activity ?? undefined,
          } satisfies ClientMessage),
        );
      }
      heartbeatRef.current = window.setInterval(() => {
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({ event: 'ping' } satisfies ClientMessage));
        }
      }, PRESENCE_HEARTBEAT_MS);
    };

    socket.onmessage = (event: MessageEvent<unknown>) => {
      const message = parseMessage(event.data);
      if (message === null) return;

      if (message.event === 'presence') {
        const entries = asArray(asRecord(message.data).entries).map(toPresence);
        // Keyed by issue so `presenceFor` is a single map read.
        const byIssue = new Map<string, PresenceEntry[]>();
        for (const entry of entries) {
          if (entry.issueId === null) continue;
          const key = String(entry.issueId);
          const bucket = byIssue.get(key);
          if (bucket === undefined) byIssue.set(key, [entry]);
          else bucket.push(entry);
        }
        stateRef.current.presence = byIssue;
        setPresenceVersion((n) => n + 1);
      }

      if (message.event === 'hello' || message.event === 'pong') return;

      const handlers = handlersRef.current.get(message.event);
      if (handlers === undefined) return;
      for (const handler of handlers) handler(message);
    };

    socket.onerror = () => {
      // `onclose` always follows; the reconnect logic lives there.
    };

    socket.onclose = () => {
      if (socketRef.current !== socket) return;
      socketRef.current = null;
      if (!enabled) {
        setStatus('closed');
        return;
      }
      attemptsRef.current += 1;
      setStatus('reconnecting');
      // Exponential backoff with jitter so a restarted server does not get a
      // synchronised stampede from every open tab.
      const ceiling = Math.min(MAX_BACKOFF_MS, 500 * 2 ** Math.min(attemptsRef.current, 6));
      const delay = Math.round(ceiling / 2 + Math.random() * (ceiling / 2));
      reconnectTimer.current = window.setTimeout(() => {
        reconnectTimer.current = null;
        connect();
      }, delay);
    };
  }, [closeSocket, enabled]);

  useEffect(() => {
    if (!enabled) {
      closeSocket();
      setStatus('closed');
      return undefined;
    }
    connect();
    return closeSocket;
  }, [enabled, connect, closeSocket]);

  useEffect(
    () => () => {
      closeSocket();
    },
    [closeSocket],
  );

  const subscribe = useCallback(
    (event: ServerEvent, handler: (message: ServerMessage) => void) => {
      let bucket = handlersRef.current.get(event);
      if (bucket === undefined) {
        bucket = new Set();
        handlersRef.current.set(event, bucket);
      }
      bucket.add(handler);
      return () => {
        bucket.delete(handler);
      };
    },
    [],
  );

  const subscribeProject = useCallback(
    (projectId: ProjectId) => {
      const message: ClientMessage = { event: 'subscribe.project', projectId };
      const key = keyOf(message);
      stateRef.current.channels.add(key);
      send(message);
      return () => {
        stateRef.current.channels.delete(key);
        send({ event: 'unsubscribe.project', projectId });
      };
    },
    [send],
  );

  const setWatching = useCallback(
    (issueId: IssueId | null, activity: string | null = null) => {
      const previous = watchingRef.current;
      if (previous?.issueId === issueId) {
        if (activity !== null) {
          watchingRef.current = { issueId, activity };
          send({ event: 'presence.cursor', issueId, activity });
        }
        return;
      }
      if (previous !== null) {
        send({ event: 'unsubscribe.issue', issueId: previous.issueId });
      }
      watchingRef.current = issueId === null ? null : { issueId, activity };
      if (issueId !== null) {
        send({
          event: 'subscribe.issue',
          issueId,
          ...(activity !== null ? { activity } : {}),
        });
      }
    },
    [send],
  );

  const presenceFor = useCallback(
    (issueId: IssueId | null) => {
      // `presenceVersion` is read so the memo invalidates on every presence push.
      void presenceVersion;
      if (issueId === null) return [];
      return stateRef.current.presence.get(String(issueId)) ?? [];
    },
    [presenceVersion],
  );

  const value = useMemo<RealtimeValue>(
    () => ({ status, subscribe, subscribeProject, presenceFor, setWatching, reconnect: connect }),
    [status, subscribe, subscribeProject, presenceFor, setWatching, connect],
  );

  return <RealtimeContext.Provider value={value}>{children}</RealtimeContext.Provider>;
}

export function useRealtime(): RealtimeValue {
  const context = useContext(RealtimeContext);
  if (context === null) throw new Error('useRealtime must be used inside a RealtimeProvider');
  return context;
}

/** Subscribes to one server event for the lifetime of the calling component. */
export function useRealtimeEvent(
  event: ServerEvent,
  handler: (message: ServerMessage) => void,
): void {
  const { subscribe } = useRealtime();
  const handlerRef = useRef(handler);
  handlerRef.current = handler;
  useEffect(
    () => subscribe(event, (message) => handlerRef.current(message)),
    [event, subscribe],
  );
}

function parseMessage(raw: unknown): ServerMessage | null {
  if (typeof raw !== 'string') return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || typeof parsed.event !== 'string') return null;
  return {
    event: parsed.event as ServerEvent,
    projectId: parsed.projectId === undefined ? undefined : asProjectId(num(parsed.projectId)),
    data: parsed.data,
    at: strOrNull(parsed.at) ?? undefined,
  };
}

function keyOf(message: ClientMessage): string {
  return [
    message.event,
    message.projectId ?? '',
    message.issueId ?? '',
    message.activity ?? '',
  ].join('|');
}

function keyToMessage(key: string): ClientMessage | null {
  const [event, projectId, issueId, activity] = key.split('|');
  if (event === undefined) return null;
  return {
    event: event as ClientMessage['event'],
    projectId:
      projectId !== undefined && projectId !== '' ? asProjectId(num(projectId)) : undefined,
    issueId: issueId !== undefined && issueId !== '' ? asIssueId(num(issueId)) : undefined,
    activity: activity !== undefined && activity !== '' ? activity : undefined,
  };
}

/** Marks presence as stale rather than dropping it, so avatars do not flicker. */
export function isPresenceStale(entry: PresenceEntry, now = Date.now(), maxAgeMs = 45_000): boolean {
  const seen = new Date(entry.lastSeenAt).getTime();
  return Number.isNaN(seen) || now - seen > maxAgeMs;
}
