/**
 * Stale-issue archiving: policy, preview, run.
 *
 * Archiving is the one bulk action here that is genuinely hard to undo, so the
 * order matters. Nothing is written until: a policy exists, the candidate list
 * says what would be archived and why, and the user confirms that exact list.
 * The scheduler can also run the same policy unattended -- this page is how you
 * see what it would do before it does it.
 */

import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useMutation, useQuery } from '../api/hooks';
import { archiveApi, type ArchivePolicy, type ArchiveRunResult } from '../api/repo';
import { asProjectId } from '../api/types';
import { Badge } from '../components/Badge';
import { Button } from '../components/Button';
import { EmptyState, ErrorState } from '../components/EmptyState';
import { useConfirm } from '../components/Modal';
import { Field } from '../components/Select';
import { SkeletonRows } from '../components/Skeleton';
import { DataTable, type Column } from '../components/Table';
import { useToast } from '../components/Toast';
import { formatRelative } from '../lib/format';

const DEFAULT_DRAFT: ArchivePolicy = {
  inactiveDays: 180,
  states: ['closed', 'resolved', 'wont_fix', 'duplicate'],
  skipIssuesWithOpenSubtasks: true,
  requireCommentWithinDays: 90,
  enabled: true,
};

export function ArchiveSettings(): JSX.Element {
  const params = useParams();
  const projectId = asProjectId(Number(params.projectId));
  const toast = useToast();
  const { confirm, dialog } = useConfirm();
  const [draft, setDraft] = useState<ArchivePolicy | null>(null);
  const [outcome, setOutcome] = useState<ArchiveRunResult | null>(null);

  const policyQuery = useQuery<ArchivePolicy | null>(
    (signal) => archiveApi.policy(projectId, signal),
    [projectId],
  );
  const candidatesQuery = useQuery(
    (signal) => archiveApi.candidates(projectId, signal),
    [projectId],
  );

  const save = useMutation<ArchivePolicy, ArchivePolicy>(
    (next) => archiveApi.savePolicy(projectId, next as unknown as Record<string, unknown>).then(() => next),
    {
      onSuccess: () => {
        policyQuery.refetch();
        candidatesQuery.refetch();
        toast.success('Archive policy saved');
      },
      onError: (error) => toast.apiError(error),
    },
  );

  const run = useMutation<void, ArchiveRunResult>(() => archiveApi.run(projectId), {
    onSuccess: (result) => {
      setOutcome(result);
      candidatesQuery.refetch();
      toast.success(
        result.archived === 0
          ? 'Nothing to archive'
          : `Archived ${result.archived} issue${result.archived === 1 ? '' : 's'}`,
      );
    },
    onError: (error) => toast.apiError(error),
  });

  if (policyQuery.error !== null) {
    return <ErrorState error={policyQuery.error} onRetry={policyQuery.refetch} />;
  }
  if (policyQuery.isLoading) return <SkeletonRows rows={4} height="48px" />;

  const policy = draft ?? policyQuery.data ?? DEFAULT_DRAFT;
  const candidates = candidatesQuery.data ?? [];
  const dirty = draft !== null;

  const columns: Column<{
    issueId: number;
    key: string;
    title: string;
    state: string;
    daysInactive: number;
    lastActivityAt: string;
    reasons: string[];
  }>[] = [
    {
      key: 'key',
      header: 'Key',
      // The detail route is keyed by id, not by human key.
      render: (row) => (
        <Link to={`/p/${projectId}/issues/${row.issueId}`} className="mono">
          {row.key}
        </Link>
      ),
    },
    { key: 'title', header: 'Title', render: (row) => row.title },
    {
      key: 'state',
      header: 'State',
      render: (row) => <Badge dot>{row.state.replace('_', ' ')}</Badge>,
    },
    {
      key: 'inactive',
      header: 'Inactive',
      numeric: true,
      render: (row) => `${row.daysInactive}d`,
    },
    {
      key: 'last',
      header: 'Last activity',
      render: (row) => formatRelative(row.lastActivityAt),
    },
    {
      key: 'why',
      header: 'Why',
      render: (row) => (
        <span className="subtle">{row.reasons.join('; ') || '—'}</span>
      ),
    },
  ];

  return (
    <div className="stack">
      <header className="row-between">
        <div>
          <h1>Stale issue archiving</h1>
          <p className="subtle">
            Archive issues that have gone quiet. The scheduler can apply this policy
            unattended; this page is how you see what it would do first.
          </p>
        </div>
        <Button
          onClick={async () => {
            const count = candidates.length;
            const agreed = await confirm({
              title: count === 0 ? 'Nothing to archive' : `Archive ${count} issue${count === 1 ? '' : 's'}?`,
              message:
                count === 0
                  ? 'No issue currently matches the policy.'
                  : 'Archiving hides these issues from the board and search. It is reversible from the issue page, but they will leave every default view.',
              confirmLabel: count === 0 ? 'Close' : 'Archive them',
              destructive: count > 0,
            });
            if (agreed && count > 0) run.mutate(undefined as never);
          }}
          disabled={run.isPending || candidates.length === 0}
          loading={run.isPending}
        >
          {candidates.length === 0 ? 'Nothing to archive' : `Archive ${candidates.length}`}
        </Button>
      </header>

      <section className="card card-pad stack" aria-label="Archive policy">
        <h2>Policy</h2>
        <div className="row" style={{ gap: 'var(--space-4)', flexWrap: 'wrap' }}>
          <Field
            label="Archive after (days idle)"
            htmlFor="archive-inactive-days"
            hint="Issues with no activity for this long."
          >
            <input
              id="archive-inactive-days"
              className="input"
              type="number"
              min={1}
              max={3650}
              value={policy.inactiveDays}
              onChange={(event) =>
                setDraft({ ...policy, inactiveDays: Number(event.target.value) })
              }
            />
          </Field>
          <Field
            label="Require a comment within (days)"
            htmlFor="archive-comment-days"
            hint="Blank means no comment requirement."
          >
            <input
              id="archive-comment-days"
              className="input"
              type="number"
              min={1}
              max={3650}
              value={policy.requireCommentWithinDays ?? ''}
              onChange={(event) =>
                setDraft({
                  ...policy,
                  requireCommentWithinDays:
                    event.target.value === '' ? null : Number(event.target.value),
                })
              }
            />
          </Field>
        </div>
        <div className="row" style={{ gap: 'var(--space-4)', flexWrap: 'wrap' }}>
          <label className="checkbox">
            <input
              type="checkbox"
              checked={policy.skipIssuesWithOpenSubtasks}
              onChange={(event) =>
                setDraft({ ...policy, skipIssuesWithOpenSubtasks: event.target.checked })
              }
            />
            Skip issues with open sub-tasks
          </label>
          <label className="checkbox">
            <input
              type="checkbox"
              checked={policy.enabled}
              onChange={(event) => setDraft({ ...policy, enabled: event.target.checked })}
            />
            Enabled
          </label>
        </div>
        <div className="row" style={{ gap: 'var(--space-2)' }}>
          <Button
            onClick={() => save.mutate(policy)}
            disabled={!dirty || save.isPending}
            loading={save.isPending}
          >
            Save policy
          </Button>
          {dirty ? (
            <Button variant="ghost" onClick={() => setDraft(null)}>
              Discard changes
            </Button>
          ) : null}
        </div>
        {policyQuery.data === null ? (
          <p className="subtle">
            No policy is set, so these are the defaults. Saving writes one to the project.
          </p>
        ) : null}
      </section>

      {outcome !== null ? (
        <p className="subtle">
          Last run archived {outcome.archived}
          {outcome.skipped > 0 ? `, skipped ${outcome.skipped}` : ''}.
          {outcome.issues.length > 0 ? ` Keys: ${outcome.issues.slice(0, 8).join(', ')}` : ''}
        </p>
      ) : null}

      {candidates.length === 0 ? (
        <EmptyState
          icon="🧹"
          title="Nothing matches the policy"
          description="No issue in this project has been quiet for long enough, or the policy is disabled."
        />
      ) : (
        <DataTable
          caption="Issues that would be archived"
          columns={columns}
          rows={candidates.map((c) => ({
            issueId: c.issueId,
            key: c.key,
            title: c.title,
            state: c.state,
            daysInactive: c.daysInactive,
            lastActivityAt: c.lastActivityAt,
            reasons: c.reasons,
          }))}
          rowKey={(row) => row.key}
        />
      )}

      {dialog}
    </div>
  );
}
