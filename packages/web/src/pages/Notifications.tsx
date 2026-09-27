/** Full notification page: the feed plus per-event delivery preferences. */

import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useMutation, useQuery } from '../api/hooks';
import { notificationApi } from '../api/repo';
import { NOTIFICATION_EVENTS, asProjectId, type NotificationEvent } from '../api/types';
import { useNotificationFeed } from '../components/NotificationBell';
import { Badge } from '../components/Badge';
import { Button } from '../components/Button';
import { EmptyState, ErrorState } from '../components/EmptyState';
import { Select } from '../components/Select';
import { SkeletonRows } from '../components/Skeleton';
import { useToast } from '../components/Toast';
import { formatRelative } from '../lib/format';

const EVENT_LABEL: Record<string, string> = {
  'issue.assigned': 'Issue assigned to you',
  'issue.unassigned': 'Issue unassigned',
  'issue.status_changed': 'Issue status changed',
  'issue.mentioned': 'You were mentioned',
  'issue.comment_added': 'New comment',
  'issue.due_soon': 'Issue due soon',
  'issue.overdue': 'Issue overdue',
  'issue.sla_breach': 'SLA breached',
  'issue.created': 'Issue created',
  'issue.priority_changed': 'Priority changed',
  'issue.blocked': 'Issue blocked',
  'issue.resolved': 'Issue resolved',
  'issue.closed': 'Issue closed',
  'comment.reply': 'Reply to your comment',
  'gitlab.sync_conflict': 'GitLab sync conflict',
  'gitlab.sync_failed': 'GitLab sync failed',
  'guest.invited': 'Guest invited',
};

export function Notifications(): JSX.Element {
  const params = useParams();
  const projectId = params.projectId === undefined ? null : asProjectId(Number(params.projectId));
  const toast = useToast();
  const { feed, isLoading, error, refetch, markAllRead, markRead } = useNotificationFeed();
  const [filter, setFilter] = useState<'all' | 'unread'>('all');
  const preferencesQuery = useQuery(() => notificationApi.preferences(), []);

  const savePreference = useMutation<{ event: NotificationEvent; inApp: boolean }, unknown>(
    ({ event, inApp }) => notificationApi.setPreference(event, inApp, true),
    {
      onSuccess: () => preferencesQuery.refetch(),
      onError: (apiError) => toast.apiError(apiError),
    },
  );

  const notifications = (feed?.notifications ?? []).filter((notification) =>
    filter === 'all' ? true : notification.readAt === null,
  );

  return (
    <div className="stack" style={{ maxWidth: 860 }}>
      <div className="page-header">
        <div className="page-title-group">
          <h1>Notifications</h1>
          <p className="page-subtitle">
            {feed === null ? 'Loading…' : `${feed.unreadCount} unread of ${feed.notifications.length} shown.`}
          </p>
        </div>
        <div className="toolbar">
          <Select
            label="Show"
            hideLabel
            value={filter}
            options={[
              { value: 'all' as const, label: 'All' },
              { value: 'unread' as const, label: 'Unread only' },
            ]}
            onChange={setFilter}
          />
          <Button onClick={markAllRead} disabled={(feed?.unreadCount ?? 0) === 0}>
            Mark all read
          </Button>
          <Button onClick={refetch} loading={isLoading}>
            Refresh
          </Button>
        </div>
      </div>

      {error !== null ? (
        <ErrorState error={error} title="Could not load notifications" onRetry={refetch} />
      ) : isLoading ? (
        <SkeletonRows rows={6} height="52px" />
      ) : notifications.length === 0 ? (
        <EmptyState
          icon="🔕"
          title={filter === 'unread' ? 'Nothing unread' : 'No notifications yet'}
          description="Mentions, assignments and status changes will show up here."
        />
      ) : (
        <div className="card">
          {notifications.map((notification) => (
            <Link
              key={notification.id}
              className={notification.readAt === null ? 'notification-item is-unread' : 'notification-item'}
              to={
                notification.issueId === null
                  ? '/notifications'
                  : `/p/${projectId ?? notification.userId}/issues/${notification.issueId}`
              }
              onClick={() => {
                if (notification.readAt === null) markRead(notification.id);
              }}
            >
              <div className="grow" style={{ minWidth: 0 }}>
                <div className="row" style={{ gap: 6 }}>
                  <strong className="truncate">{notification.title}</strong>
                  {notification.readAt === null ? <Badge tone="accent">New</Badge> : null}
                </div>
                <p className="subtle" style={{ margin: 0 }}>
                  {notification.body}
                </p>
                <p className="subtle" style={{ margin: 0 }} title={notification.createdAt}>
                  {EVENT_LABEL[notification.event] ?? notification.event} · {formatRelative(notification.createdAt)}
                </p>
              </div>
            </Link>
          ))}
        </div>
      )}

      <section className="card card-pad stack" aria-label="Delivery preferences">
        <h2>In-app delivery</h2>
        <p className="subtle">Turn off the events you do not want in the bell.</p>
        <div className="link-list">
          {NOTIFICATION_EVENTS.map((event) => {
            const inApp = preferencesQuery.data?.[event]?.inApp ?? true;
            return (
              <label key={event} className="link-row" style={{ cursor: 'pointer' }}>
                <span className="truncate">{EVENT_LABEL[event] ?? event}</span>
                <span className="row" style={{ gap: 6 }}>
                  <span className="subtle mono">{event}</span>
                  <input
                    type="checkbox"
                    checked={inApp}
                    disabled={savePreference.isPending}
                    aria-label={`In-app notifications for ${event}`}
                    onChange={(domEvent) =>
                      void savePreference.mutate({ event, inApp: domEvent.target.checked })
                    }
                  />
                </span>
              </label>
            );
          })}        </div>
        {preferencesQuery.error !== null ? (
          <p className="subtle">Preferences could not be loaded; the checkboxes show defaults.</p>
        ) : null}
      </section>
    </div>
  );
}
