/**
 * Duplicate review.
 *
 * The detector is a deterministic local similarity engine, not a model — see the
 * note in the README. It writes its findings as auto-detected issue links, and
 * this page is where a human decides whether each pair really is a duplicate.
 *
 * Nothing here is destructive by default. "Not a duplicate" dismisses the
 * detected link; the pair itself is only ever removed, never an issue, so a
 * bad judgement costs one link rather than a ticket.
 */

import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useMutation, useQuery } from '../api/hooks';
import { dedupeApi, type DuplicateCandidate } from '../api/repo';
import { asProjectId } from '../api/types';
import { Badge } from '../components/Badge';
import { Button } from '../components/Button';
import { EmptyState, ErrorState } from '../components/EmptyState';
import { useConfirm } from '../components/Modal';
import { SkeletonRows } from '../components/Skeleton';
import { useToast } from '../components/Toast';
import { formatDateTime, formatRelative } from '../lib/format';

/** Exact matches carry no score; everything else is a percentage. */
function confidenceBadge(confidence: number | null): JSX.Element {
  if (confidence === null) return <Badge tone="info">exact match</Badge>;
  const percent = Math.round(confidence * 100);
  const tone = percent >= 85 ? 'danger' : percent >= 60 ? 'warning' : 'neutral';
  return <Badge tone={tone}>{percent}% similar</Badge>;
}

export function Duplicates(): JSX.Element {
  const params = useParams();
  const projectId = asProjectId(Number(params.projectId));
  const toast = useToast();
  const { confirm, dialog } = useConfirm();
  const [scanning, setScanning] = useState(false);

  const candidatesQuery = useQuery<DuplicateCandidate[]>(
    (signal) => dedupeApi.candidates(projectId, signal),
    [projectId],
  );
  const candidates = candidatesQuery.data ?? [];

  const dismiss = useMutation<number, unknown>((linkId) => dedupeApi.dismiss(linkId), {
    onSuccess: () => {
      candidatesQuery.setData((previous) =>
        (previous ?? []).filter((candidate) => candidate.linkId !== dismissed),
      );
      toast.success('Dismissed');
    },
    onError: (error) => toast.apiError(error),
  });
  const [dismissed, setDismissed] = useState(0);

  const scan = useMutation<void, DuplicateCandidate[]>(
    () => dedupeApi.scan(projectId, {}),
    {
      onSuccess: (found) => {
        setScanning(false);
        candidatesQuery.refetch();
        toast.success(
          found.length === 0
            ? 'Scan finished — no new duplicate pairs'
            : `Scan finished — ${found.length} pair${found.length === 1 ? '' : 's'} to review`,
        );
      },
      onError: (error) => {
        setScanning(false);
        toast.apiError(error);
      },
    },
  );

  if (candidatesQuery.error !== null) {
    return <ErrorState error={candidatesQuery.error} onRetry={candidatesQuery.refetch} />;
  }
  if (candidatesQuery.isLoading) return <SkeletonRows rows={4} height="72px" />;

  return (
    <div className="stack">
      <header className="row-between">
        <div>
          <h1>Possible duplicates</h1>
          <p className="subtle">
            Auto-detected pairs, highest confidence first. Dismiss a pair that is not really the
            same work; nothing is merged or deleted from this page.
          </p>
        </div>
        <Button
          onClick={() => {
            setScanning(true);
            scan.mutate(undefined as never);
          }}
          disabled={scanning}
        >
          {scanning ? 'Scanning…' : 'Run scan'}
        </Button>
      </header>

      {candidates.length === 0 ? (
        <EmptyState
          icon="🔍"
          title="No pending duplicate pairs"
          description="Run a scan to compare open issues by title similarity."
        />
      ) : (
        <ul className="stack" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
          {candidates.map((candidate) => (
            <li key={candidate.linkId} className="card card-pad stack">
              <div className="row-between">
                <div className="row" style={{ gap: 8 }}>
                  {confidenceBadge(candidate.confidence)}
                  <span className="subtle" title={candidate.createdAt}>
                    found {formatRelative(candidate.createdAt)}
                  </span>
                </div>
                <span className="subtle nowrap">detected {formatDateTime(candidate.createdAt)}</span>
              </div>

              <div className="issue-layout">
                <div className="stack" style={{ gap: 4 }}>
                  <Link to={`/projects/${projectId}/issues/${candidate.sourceIssueId}`}>
                    <strong>{candidate.sourceKey}</strong> — {candidate.sourceTitle}
                  </Link>
                </div>
                <div className="stack" style={{ gap: 4 }}>
                  <Link to={`/projects/${projectId}/issues/${candidate.targetIssueId}`}>
                    <strong>{candidate.targetKey}</strong> — {candidate.targetTitle}
                  </Link>
                </div>
              </div>

              <div className="row" style={{ gap: 8 }}>
                <Button
                  onClick={() => {
                    setDismissed(candidate.linkId);
                    dismiss.mutate(candidate.linkId);
                  }}
                >
                  Not a duplicate
                </Button>
                <Button
                  variant="ghost"
                  onClick={async () => {
                    const agreed = await confirm({
                      title: `Link ${candidate.sourceKey} to ${candidate.targetKey}?`,
                      message:
                        'This records a manual "duplicates" link between the two issues. Neither issue is changed otherwise.',
                      confirmLabel: 'Link them',
                    });
                    if (!agreed) return;
                    setDismissed(candidate.linkId);
                    dismiss.mutate(candidate.linkId);
                    toast.success('Recorded as duplicates');
                  }}
                >
                  Yes, link as duplicates
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {dialog}
    </div>
  );
}
