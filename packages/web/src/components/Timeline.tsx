import { ACTIVITY_LABEL, type ActivityEvent, type IssueTimeline } from '../api/types';
import {
  formatDuration,
  formatHours,
  formatRelative,
  formatSignedDuration,
} from '../lib/format';
import { Badge } from './Badge';
import { EmptyState } from './EmptyState';
import { SkeletonRows } from './Skeleton';

export interface TimelineProps {
  timeline: IssueTimeline | null;
  isLoading: boolean;
  /** Extra events pushed over the socket, prepended to the server's history. */
  liveEvents?: readonly ActivityEvent[];
}

/** Per-issue timing header: age, lead time, cycle time and the overdue badge. */
export function TimingStrip({ timeline }: { timeline: IssueTimeline | null }): JSX.Element | null {
  if (timeline === null) return null;
  const t = timeline.timing;
  const overdue = t.overdueByMs !== null && t.overdueByMs > 0;

  return (
    <div className="timing-strip" aria-label="Issue timing">
      <TimingItem label="Age" value={formatDuration(t.ageMs)} />
      <TimingItem label="Time to start" value={formatDuration(t.timeToStartMs)} />
      <TimingItem label="In progress" value={formatDuration(t.timeInProgressMs)} />
      <TimingItem label="Time to resolve" value={formatDuration(t.timeToResolveMs)} />
      <TimingItem label="Time to close" value={formatDuration(t.timeToCloseMs)} />
      <TimingItem label="Logged" value={formatHours(t.totalLoggedHours)} />
      <div className="timing-item">
        <span className="timing-label">Overdue</span>
        <span className="timing-value">
          {overdue ? (
            <Badge tone="danger" title="Past the due date">
              {formatSignedDuration(t.overdueByMs)}
            </Badge>
          ) : (
            <Badge tone={t.dueDate === null ? 'neutral' : 'success'}>
              {t.dueDate === null ? 'No due date' : 'On track'}
            </Badge>
          )}
        </span>
      </div>
    </div>
  );
}

function TimingItem({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <div className="timing-item">
      <span className="timing-label">{label}</span>
      <span className="timing-value">{value}</span>
    </div>
  );
}

/** Newest-first activity feed, merging pushed events with the fetched history. */
export function Timeline({ timeline, isLoading, liveEvents = [] }: TimelineProps): JSX.Element {
  if (isLoading) return <SkeletonRows rows={5} height="38px" />;
  if (timeline === null) {
    return <EmptyState icon="🕓" title="No activity yet" description="Changes to this issue will appear here." />;
  }

  const seen = new Set(timeline.events.map((event) => event.id));
  const merged = [
    ...liveEvents.filter((event) => !seen.has(event.id)),
    ...timeline.events,
  ].sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  if (merged.length === 0) {
    return <EmptyState icon="🕓" title="No activity yet" description="Changes to this issue will appear here." />;
  }

  return (
    <ol className="timeline" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
      {merged.map((event, index) => (
        <li key={event.id} className="timeline-item">
          {index < merged.length - 1 ? <span className="timeline-rail" aria-hidden="true" /> : null}
          <span className="timeline-marker" aria-hidden="true">
            {markerFor(event.type)}
          </span>
          <div className="timeline-body">
            <div className="row-between">
              <strong style={{ fontWeight: 500 }}>{event.summary || ACTIVITY_LABEL[event.type]}</strong>
              <span className="subtle nowrap" title={event.createdAt}>
                {formatRelative(event.createdAt)}
              </span>
            </div>
            <span className="subtle">{ACTIVITY_LABEL[event.type]}</span>
            {event.changes.length > 0 ? (
              <ul className="stack-sm" style={{ listStyle: 'none', margin: '6px 0 0', padding: 0 }}>
                {event.changes.slice(0, 6).map((change, changeIndex) => (
                  <li key={`${event.id}-${change.field}-${changeIndex}`} className="subtle">
                    <code>{change.field}</code>: {describe(change.from)} â†’ {describe(change.to)}
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        </li>
      ))}
    </ol>
  );
}

function describe(value: unknown): string {
  if (value === null || value === undefined || value === '') return '—';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function markerFor(type: ActivityEvent['type']): string {
  if (type.startsWith('comment.')) return '💬';
  if (type.startsWith('gitlab.')) return '🔗';
  if (type.startsWith('sla.')) return 'â±';
  if (type.startsWith('attachment.')) return '📎';
  if (type === 'issue.transitioned') return 'â†’';
  if (type === 'issue.created') return '+';
  if (type === 'issue.assigned' || type === 'issue.unassigned') return '@';
  if (type === 'issue.archived' || type === 'issue.unarchived') return '🗄️';
  return '•';
}
