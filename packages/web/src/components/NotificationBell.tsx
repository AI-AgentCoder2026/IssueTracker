/**
 * Notification feed. The bell shows the unread count and a compact list; the
 * full page renders the same feed with delivery preferences.
 */

import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '../api/hooks';
import { notificationApi } from '../api/repo';
import { asRecord, num, str } from '../api/normalize';
import type { Notification, NotificationFeed } from '../api/types';
import { useRealtime, useRealtimeEvent } from '../realtime/useRealtime';
import { formatRelative } from '../lib/format';
import { Badge } from './Badge';
import { Button } from './Button';
import { EmptyState, ErrorState } from './EmptyState';
import { Menu } from './Menu';
import { SkeletonRows } from './Skeleton';
import { useToast } from './Toast';

function toPushedNotification(data: unknown): Notification | null {
  const r = asRecord(data);
  if (r.id === undefined) return null;
  return {
    id: num(r.id),
    userId: num(r.userId) as never,
    event: str(r.event, 'issue.updated') as Notification['event'],
    issueId: r.issueId === null || r.issueId === undefined ? null : (num(r.issueId) as never),
    title: str(r.title),
    body: str(r.body),
    payload: asRecord(r.payload),
    readAt: null,
    createdAt: str(r.createdAt, new Date().toISOString()),
  };
}

/**
 * Subscribes to the `notification` socket event and merges it into the fetched
 * feed, so the bell updates without a refetch.
 */
export function useNotificationFeed(): {
  feed: NotificationFeed | null;
  isLoading: boolean;
  error: unknown;
  refetch: () => void;
  markAllRead: () => void;
  markRead: (id: number) => void;
} {
  const toast = useToast();
  const query = useQuery<NotificationFeed>((signal) => notificationApi.list(30, signal), []);
  const [live, setLive] = useState<Notification[]>([]);

  useRealtimeEvent('notification', (message) => {
    const pushed = toPushedNotification(message.data);
    if (pushed === null) return;
    setLive((current) => [pushed, ...current.filter((n) => n.id !== pushed.id)].slice(0, 30));
  });

  useEffect(() => {
    // The socket is only a hint; a background refetch is the source of truth.
    if (live.length === 0) return undefined;
    const timer = window.setTimeout(() => query.refetch(), 1_500);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live.length]);

  const markAllRead = useCallback(() => {
    void notificationApi
      .markAllRead()
      .then(() => {
        setLive([]);
        query.setData((previous) =>
          previous === null
            ? previous
            : {
                notifications: previous.notifications.map((n) => ({
                  ...n,
                  readAt: n.readAt ?? new Date().toISOString(),
                })),
                unreadCount: 0,
              },
        );
      })
      .catch((cause: unknown) => toast.apiError(cause));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [toast]);

  const markRead = useCallback((id: number) => {
    void notificationApi
      .markRead([id])
      .then(() => query.refetch())
      .catch((cause: unknown) => toast.apiError(cause));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [toast]);

  const base = query.data;
  const feed =
    base === null
      ? null
      : {
          notifications: [...live, ...base.notifications].filter(
            (notification, index, all) =>
              all.findIndex((candidate) => candidate.id === notification.id) === index,
          ),
          unreadCount: live.filter((n) => n.readAt === null).length + base.unreadCount,
        };

  return {
    feed,
    isLoading: query.isLoading,
    error: query.error,
    refetch: query.refetch,
    markAllRead,
    markRead,
  };
}

export interface NotificationBellProps {
  projectId: number | null;
}

/** Topbar bell: unread count badge plus the latest notifications. */
export function NotificationBell({ projectId }: NotificationBellProps): JSX.Element {
  const { feed, isLoading, error, markAllRead, markRead } = useNotificationFeed();
  const { status } = useRealtime();
  const unread = feed?.unreadCount ?? 0;
  const href = projectId === null ? '/notifications' : `/p/${projectId}/notifications`;

  return (
    <Menu
      label="Notifications"
      align="right"
      renderTrigger={({ open, toggle, ref }) => (
        <button
          ref={ref}
          type="button"
          className="btn btn--ghost btn--icon"
          aria-haspopup="menu"
          aria-expanded={open}
          aria-label={unread > 0 ? `Notifications, ${unread} unread` : 'Notifications'}
          onClick={toggle}
          style={{ position: 'relative' }}
        >
          <span aria-hidden="true">ðŸ””</span>
          {unread > 0 ? (
            <span className="bell-count" aria-hidden="true">
              {unread > 99 ? '99+' : unread}
            </span>
          ) : null}
        </button>
      )}
    >
      {(close) => (
        <div style={{ minWidth: 300, maxWidth: 380 }}>
          <div className="row-between" style={{ padding: '4px 8px 8px' }}>
            <strong>Notifications</strong>
            <Button
              size="sm"
              variant="ghost"
              onClick={markAllRead}
              disabled={unread === 0}
              aria-label="Mark all notifications as read"
            >
              Mark all read
            </Button>
          </div>
          {status !== 'open' ? (
            <p className="subtle" style={{ padding: '0 8px 6px' }}>
              Live updates are {status === 'closed' ? 'disconnected' : status}. Pull to refresh on the
              notifications page.
            </p>
          ) : null}
          <div style={{ maxHeight: 340, overflowY: 'auto' }}>
            {isLoading ? (
              <div style={{ padding: 8 }}>
                <SkeletonRows rows={3} height="36px" />
              </div>
            ) : error !== null ? (
              <div style={{ padding: 8 }}>
                <ErrorState error={error} title="Could not load notifications" />
              </div>
            ) : (feed?.notifications.length ?? 0) === 0 ? (
              <EmptyState icon="ðŸ”•" title="You're all caught up" description="No notifications yet." />
            ) : (
              (feed?.notifications ?? []).slice(0, 12).map((notification) => (
                <Link
                  key={notification.id}
                  className={notification.readAt === null ? 'notification-item is-unread' : 'notification-item'}
                  to={notification.issueId === null ? href : `/p/${projectId ?? ''}/issues/${notification.issueId}`}
                  onClick={() => {
                    if (notification.readAt === null) markRead(notification.id);
                    close();
                  }}
                >
                  <div className="grow" style={{ minWidth: 0 }}>
                    <div className="truncate" style={{ fontWeight: 500 }}>
                      {notification.title}
                    </div>
                    <div className="subtle truncate">{notification.body}</div>
                    <div className="subtle">{formatRelative(notification.createdAt)}</div>
                  </div>
                  {notification.readAt === null ? <Badge tone="accent">New</Badge> : null}
                </Link>
              ))
            )}
          </div>
          <div style={{ padding: '8px 4px 4px' }}>
            <Link to={href} onClick={close}>
              View all notifications
            </Link>
          </div>
        </div>
      )}
    </Menu>
  );
}
