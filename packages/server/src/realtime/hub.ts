/**
 * Real-time hub.
 *
 * Owns channel membership and the presence table, and fans messages out to
 * whatever transport is attached. It is deliberately transport-agnostic: the
 * WebSocket route subscribes sockets, but tests and background jobs can publish
 * without a socket ever existing.
 *
 * Channels:
 *   project:<id>    board and issue events for one project
 *   issue:<id>      detail view, used for comment and presence updates
 *   dashboard:<id>  per-dashboard refresh signals
 *   user:<id>       direct notifications
 */

import type { PresenceEntry, ServerEvent } from '@tracker/shared';

/** A transport that can deliver a serialized frame to a subscriber. */
export type Subscriber = (data: string) => void;

interface Channel {
  name: string;
  subscribers: Set<Subscriber>;
}

export interface PublishOptions {
  /** Restrict delivery to these user ids. */
  userIds?: number[];
  /** Skip the sender, so the originating client does not double-apply. */
  exceptUserId?: number;
  /** Correlation id echoed back to the client that caused the event. */
  ref?: string;
}

export interface PublishInput {
  event: ServerEvent;
  data?: unknown;
  projectId?: number;
  issueId?: number;
  userIds?: number[];
  at?: string;
}

export class RealtimeHub {
  private readonly channels = new Map<string, Channel>();
  /** Presence keyed by `userId:connectionId` so one user can hold several tabs. */
  private readonly presence = new Map<string, PresenceEntry & { connectionId: string }>();

  private channelFor(name: string): Channel {
    let channel = this.channels.get(name);
    if (!channel) {
      channel = { name, subscribers: new Set() };
      this.channels.set(name, channel);
    }
    return channel;
  }

  subscribe(name: string, subscriber: Subscriber): () => void {
    const channel = this.channelFor(name);
    channel.subscribers.add(subscriber);
    return () => {
      channel.subscribers.delete(subscriber);
      // Drop empty channels so a long-lived server does not accumulate them.
      if (channel.subscribers.size === 0) this.channels.delete(name);
    };
  }

  /**
   * Publish to every channel relevant to the event: the project, the issue and
   * any directly-addressed users.
   */
  publish(input: PublishInput, options: PublishOptions = {}): number {
    const frame = JSON.stringify({
      event: input.event,
      data: input.data,
      projectId: input.projectId,
      issueId: input.issueId,
      ref: options.ref,
      at: input.at ?? new Date().toISOString(),
    });

    const targets = new Set<Channel>();
    if (input.projectId !== undefined) targets.add(this.channelFor(`project:${input.projectId}`));
    if (input.issueId !== undefined) targets.add(this.channelFor(`issue:${input.issueId}`));
    for (const userId of input.userIds ?? []) targets.add(this.channelFor(`user:${userId}`));

    let delivered = 0;
    for (const channel of targets) {
      for (const subscriber of channel.subscribers) {
        try {
          subscriber(frame);
          delivered += 1;
        } catch {
          // A single broken socket must not stop delivery to the rest.
          channel.subscribers.delete(subscriber);
        }
      }
    }
    return delivered;
  }

  // -------------------------------------------------------------------------
  // Presence
  // -------------------------------------------------------------------------

  /**
   * Register a connected user. Presence is per connection so a user with the
   * issue open in two tabs appears once per tab, matching what users expect
   * from a "who else is here" indicator.
   */
  setPresence(entry: Omit<PresenceEntry, 'lastSeenAt'> & { connectionId: string }): void {
    this.presence.set(`${entry.userId}:${entry.connectionId}`, {
      ...entry,
      lastSeenAt: new Date().toISOString(),
    });
  }

  clearPresence(userId: number, connectionId: string): void {
    this.presence.delete(`${userId}:${connectionId}`);
  }

  /**
   * Presence for a project, de-duplicated by user (highest activity first).
   *
   * Scoping is strict: an entry is visible to project P if and only if it
   * names P. An entry with a null `projectId` — a socket that has connected
   * but not yet chosen anywhere — belongs to no project and is therefore
   * visible to none. Treating null as "everywhere" would broadcast the display
   * names of connected users to projects they were never granted access to.
   */
  presenceForProject(projectId: number): PresenceEntry[] {
    const byUser = new Map<number, PresenceEntry & { connectionId: string }>();
    for (const entry of this.presence.values()) {
      if (entry.projectId !== projectId) continue;
      const existing = byUser.get(entry.userId);
      // Prefer an entry that is actually looking at an issue. Scoping has
      // already guaranteed both candidates are the same project, so this
      // cannot promote another project's entry.
      if (!existing || (existing.issueId === null && entry.issueId !== null)) {
        byUser.set(entry.userId, entry);
      }
    }
    return [...byUser.values()].map(({ connectionId: _connectionId, ...entry }) => entry);
  }

  /** Connections are considered stale after this long without a heartbeat. */
  private static readonly PRESENCE_TTL_MS = 45_000;

  /** Drop presence entries whose socket never sent a heartbeat. */
  prunePresence(): number {
    const cutoff = Date.now() - RealtimeHub.PRESENCE_TTL_MS;
    let removed = 0;
    for (const [key, entry] of this.presence) {
      if (new Date(entry.lastSeenAt).getTime() < cutoff) {
        this.presence.delete(key);
        removed += 1;
      }
    }
    return removed;
  }

  stats(): { channels: number; subscribers: number; presenceEntries: number } {
    let subscribers = 0;
    for (const channel of this.channels.values()) subscribers += channel.subscribers.size;
    return {
      channels: this.channels.size,
      subscribers,
      presenceEntries: this.presence.size,
    };
  }

  /** Drop every subscriber; used between tests. */
  reset(): void {
    this.channels.clear();
    this.presence.clear();
  }
}
