/**
 * Project SLA overview: what is at risk and what has already breached.
 *
 * The per-issue countdown lives on the issue page; this is the triage view —
 * "what should I look at next" — sorted so the worst is first. Both lists are
 * read-only; a clock is settled by the work that actually happened, not by
 * editing it here.
 */

import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useQuery, useTicker } from '../api/hooks';
import { slaApi, type SlaStatus } from '../api/repo';
import { asProjectId } from '../api/types';
import { Badge } from '../components/Badge';
import { Button } from '../components/Button';
import { EmptyState, ErrorState } from '../components/EmptyState';
import { SkeletonRows } from '../components/Skeleton';
import { DataTable, type Column } from '../components/Table';
import { formatDuration } from '../lib/format';

const WINDOWS = [
  { value: 1, label: 'Next hour' },
  { value: 4, label: 'Next 4 hours' },
  { value: 24, label: 'Next day' },
  { value: 72, label: 'Next 3 days' },
];

type ClockRow = SlaStatus;

/**
 * Worst first. For a breached clock `remainingMs` is negative, so sorting
 * ascending puts the most-overdue at the top; for an at-risk clock it is
 * positive, so the soonest deadline rises. One comparison serves both.
 */
function rows(clocks: SlaStatus[]): ClockRow[] {
  return [...clocks].sort((a, b) => (a.remainingMs ?? 0) - (b.remainingMs ?? 0));
}

export function ProjectSla(): JSX.Element {
  const params = useParams();
  const projectId = asProjectId(Number(params.projectId));
  const [windowHours, setWindowHours] = useState(24);
  // Countdowns must reflect the present, not the moment the page loaded.
  useTicker(60_000);

  const atRiskQuery = useQuery<SlaStatus[]>(
    (signal) => slaApi.atRisk(projectId, windowHours * 3_600_000, signal),
    [projectId, windowHours],
  );
  const breachedQuery = useQuery<SlaStatus[]>(
    (signal) => slaApi.breached(projectId, signal),
    [projectId],
  );

  if (atRiskQuery.error !== null) {
    return <ErrorState error={atRiskQuery.error} onRetry={atRiskQuery.refetch} />;
  }
  if (atRiskQuery.isLoading || breachedQuery.isLoading) {
    return <SkeletonRows rows={4} height="40px" />;
  }

  const atRisk = rows(atRiskQuery.data ?? []);
  const breached = rows(breachedQuery.data ?? []);

  const columns = (isBreached: boolean): Column<ClockRow>[] => [
    {
      key: 'issue',
      header: 'Issue',
      // The SLA endpoints report an id, not a key; the detail route takes the id.
      render: (row) => (
        <Link to={`/p/${projectId}/issues/${row.issueId}`} className="mono">
          #{row.issueId}
        </Link>
      ),
    },
    {
      key: 'target',
      header: 'Target',
      render: (row) => (row.target === 'response' ? 'First response' : 'Resolution'),
    },
    {
      key: 'remaining',
      header: isBreached ? 'Overdue by' : 'Due in',
      numeric: true,
      render: (row) =>
        formatDuration(Math.abs(row.remainingMs ?? 0)),
    },
    {
      key: 'state',
      header: 'State',
      render: () => (
        <Badge tone={isBreached ? 'danger' : 'warning'}>
          {isBreached ? 'breached' : 'at risk'}
        </Badge>
      ),
    },
  ];

  return (
    <div className="stack">
      <header className="row-between">
        <div>
          <h1>Service levels</h1>
          <p className="subtle">
            {breached.length} breached · {atRisk.length} at risk. Clocks settle when the work
            happens, so nothing here needs acknowledging by hand.
          </p>
        </div>
        <div className="row" style={{ gap: 'var(--space-2)' }}>
          {WINDOWS.map((option) => (
            <Button
              key={option.value}
              variant={option.value === windowHours ? 'primary' : 'ghost'}
              onClick={() => setWindowHours(option.value)}
            >
              {option.label}
            </Button>
          ))}
        </div>
      </header>

      <section className="stack" aria-label="Breached">
        <h2>Breached</h2>
        {breached.length === 0 ? (
          <EmptyState icon="✅" title="Nothing breached" description="Every clock is still within its target." />
        ) : (
          <DataTable
            caption="SLA clocks already past due"
            columns={columns(true)}
            rows={breached}
            rowKey={(row) => `${row.policyId}-${row.issueId}-${row.target}`}
          />
        )}
      </section>

      <section className="stack" aria-label="At risk">
        <h2>At risk</h2>
        {atRisk.length === 0 ? (
          <EmptyState
            icon="🕐"
            title="Nothing due in this window"
            description="Widen the window to look further ahead."
          />
        ) : (
          <DataTable
            caption="SLA clocks approaching their target"
            columns={columns(false)}
            rows={atRisk}
            rowKey={(row) => `${row.policyId}-${row.issueId}-${row.target}`}
          />
        )}
      </section>
    </div>
  );
}
