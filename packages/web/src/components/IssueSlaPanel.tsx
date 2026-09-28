/**
 * SLA countdown for one issue.
 *
 * The countdown is the point: `remainingMs` is negative once breached, and the
 * badge says so rather than showing an absolute duration that reads as though
 * the deadline were still ahead. A met clock shows when it was met instead of
 * counting down to something that no longer applies.
 */

import { useParams } from 'react-router-dom';
import { useQuery, useTicker } from '../api/hooks';
import { slaApi, type SlaStatus } from '../api/repo';
import { asIssueId } from '../api/types';
import { Badge } from './Badge';
import { SkeletonRows } from './Skeleton';
import { formatDuration, formatSignedDuration } from '../lib/format';

const TONE: Record<SlaStatus['state'], 'danger' | 'warning' | 'success' | 'neutral'> = {
  breached: 'danger',
  at_risk: 'warning',
  met: 'success',
  on_track: 'neutral',
  not_started: 'neutral',
};

const TARGET_LABEL: Record<string, string> = {
  response: 'First response',
  resolution: 'Resolution',
};

function describe(clock: SlaStatus): string {
  switch (clock.state) {
    case 'met':
      return 'met';
    case 'breached':
      return `breached by ${formatDuration(Math.abs(clock.remainingMs ?? 0))}`;
    case 'at_risk':
      return `${formatDuration(clock.remainingMs ?? 0)} left`;
    case 'on_track':
      return `${formatDuration(clock.remainingMs ?? 0)} left`;
    default:
      return 'not started';
  }
}

export function IssueSlaPanel(): JSX.Element | null {
  const params = useParams();
  const issueId = asIssueId(Number(params.issueId));
  // The remaining time is a function of *now*, so the panel re-renders on a
  // timer rather than showing a value frozen at page load.
  useTicker(30_000);

  const clocksQuery = useQuery<SlaStatus[]>((signal) => slaApi.forIssue(issueId, signal), [issueId]);

  if (clocksQuery.isLoading) return <SkeletonRows rows={1} height="32px" />;

  const clocks = clocksQuery.data ?? [];
  if (clocks.length === 0) return null;

  const now = Date.now();
  return (
    <section className="card card-pad stack" aria-label="SLA">
      <h2>Service levels</h2>
      <ul className="stack" style={{ listStyle: 'none', margin: 0, padding: 0, gap: 6 }}>
        {clocks.map((clock) => (
          <li key={`${clock.policyId}-${clock.target}`} className="row-between">
            <span>{TARGET_LABEL[clock.target] ?? clock.target}</span>
            <span className="row" style={{ gap: 8 }}>
              {clock.dueAt !== null ? (
                <span className="subtle nowrap" title={`Due ${clock.dueAt}`}>
                  due {formatDuration(Math.max(0, Date.parse(clock.dueAt) - now))}
                </span>
              ) : null}
              <Badge tone={TONE[clock.state] ?? 'neutral'}>
                {clock.state === 'breached' && clock.remainingMs !== null
                  ? formatSignedDuration(clock.remainingMs)
                  : describe(clock)}
              </Badge>
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
