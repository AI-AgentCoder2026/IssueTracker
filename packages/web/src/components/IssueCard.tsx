import { Link } from 'react-router-dom';
import { cx, formatRelative } from '../lib/format';
import type { IssueSummary, ProjectId } from '../api/types';
import { Avatar } from './Avatar';
import { Badge } from './Badge';

const PRIORITY_COLOR: Record<string, string> = {
  lowest: '#94a3b8',
  low: '#60a5fa',
  medium: '#f59e0b',
  high: '#fb923c',
  highest: '#f87171',
  critical: '#ef4444',
};

const TYPE_ICON: Record<string, string> = {
  bug: '🐞',
  feature: '✨',
  task: '☑',
  incident: '🔥',
  chore: '🧰',
  question: '❓',
};

export interface IssueCardProps {
  issue: IssueSummary;
  projectId: ProjectId;
  /** Draggable on the board; omitted elsewhere (list rows are links only). */
  draggable?: boolean;
  dragging?: boolean;
  onDragStart?: (event: React.DragEvent<HTMLElement>) => void;
  onDragEnd?: () => void;
  labels?: ReadonlyMap<number, string>;
}

/** Compact issue summary used as a Kanban card and as a dashboard list row. */
export function IssueCard({
  issue,
  projectId,
  draggable = false,
  dragging = false,
  onDragStart,
  onDragEnd,
  labels,
}: IssueCardProps): JSX.Element {
  const href = `/p/${projectId}/issues/${issue.id}`;
  const labelNames = issue.labelIds
    .map((id) => labels?.get(id))
    .filter((name): name is string => typeof name === 'string');

  return (
    <div
      className={cx('issue-card', dragging && 'is-dragging', issue.isOverdue && 'is-overdue')}
      draggable={draggable}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      data-issue-id={issue.id}
    >
      <div className="row-between">
        <span className="issue-key">{issue.key}</span>
        <span
          className="priority-chip"
          style={{ background: PRIORITY_COLOR[issue.priority] ?? '#94a3b8' }}
          title={`Priority: ${issue.priority}`}
          aria-label={`Priority ${issue.priority}`}
          role="img"
        />
      </div>
      <Link to={href} className="truncate" style={{ fontWeight: 500 }}>
        <span aria-hidden="true" className="subtle">
          {TYPE_ICON[issue.type] ?? '•'}{' '}
        </span>
        {issue.title}
      </Link>
      {labelNames.length > 0 ? (
        <div className="row" style={{ gap: 4 }}>
          {labelNames.slice(0, 3).map((name) => (
            <Badge key={name}>{name}</Badge>
          ))}
        </div>
      ) : null}
      <div className="row-between">
        <span className="row" style={{ gap: 6 }}>
          {issue.assigneeName === null ? (
            <span className="subtle">Unassigned</span>
          ) : (
            <Avatar name={issue.assigneeName} size="sm" />
          )}
          {issue.subtaskCount > 0 ? <span className="subtle">⊞ {issue.subtaskCount}</span> : null}
          {issue.commentCount > 0 ? <span className="subtle">💬 {issue.commentCount}</span> : null}
        </span>
        <span className="row" style={{ gap: 6 }}>
          {issue.isOverdue ? <Badge tone="danger">Overdue</Badge> : null}
          <span className="subtle nowrap" title={issue.lastActivityAt}>
            {formatRelative(issue.lastActivityAt)}
          </span>
        </span>
      </div>
    </div>
  );
}
