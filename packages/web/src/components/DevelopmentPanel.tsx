/**
 * Development panel: the version-control artefacts linked to an issue.
 *
 * Shows branches, commits and merge requests, lets a reviewer mark one merged,
 * and offers a branch-name preview so a developer can confirm their naming
 * convention resolves correctly before pushing a branch.
 */

import { useCallback, useState } from 'react';
import type { IssueReferenceView, ReferenceKind, Repository } from '../api/types';
import { REFERENCE_KIND_LABEL } from '@tracker/shared';
import { vcsApi } from '../api/repo';
import { useQuery } from '../api/hooks';
import { Badge } from './Badge';
import { Button } from './Button';
import { EmptyState } from './EmptyState';
import { Spinner } from './Spinner';
import { formatRelative } from '../lib/format';

interface DevelopmentPanelProps {
  issueId: number;
  projectId: number;
  repositories: Repository[];
  onError: (message: string) => void;
}

const KIND_ORDER: ReferenceKind[] = [
  'branch',
  'commit',
  'merge_request',
  'pull_request',
  'tag',
  'file',
];

/** Colour the badge by what the artefact means, not by provider. */
function toneFor(reference: IssueReferenceView): 'success' | 'info' | 'neutral' {
  if (reference.isMerged) return 'success';
  if (reference.kind === 'merge_request' || reference.kind === 'pull_request') return 'info';
  return 'neutral';
}

export function DevelopmentPanel({
  issueId,
  projectId,
  repositories,
  onError,
}: DevelopmentPanelProps) {
  const query = useQuery((signal) => vcsApi.references(issueId, signal), [issueId]);
  const [busy, setBusy] = useState(false);
  const [previewBranch, setPreviewBranch] = useState('');
  const [previewResult, setPreviewResult] = useState<{
    issueKey: string | null;
    issue: { id: number; key: string; title: string } | null;
  } | null>(null);
  const [adding, setAdding] = useState(false);
  const [draftKind, setDraftKind] = useState<ReferenceKind>('branch');
  const [draftRef, setDraftRef] = useState('');
  const [draftRepositoryId, setDraftRepositoryId] = useState<string>('');

  const references = query.data?.references ?? [];
  const summary = query.data?.summary;

  const refresh = useCallback(() => {
    void query.refetch();
  }, [query]);

  async function markMerged(reference: IssueReferenceView): Promise<void> {
    setBusy(true);
    try {
      await vcsApi.updateReference(issueId, reference.id, { state: 'merged' });
      refresh();
    } catch (error) {
      onError(error instanceof Error ? error.message : 'Could not update the reference');
    } finally {
      setBusy(false);
    }
  }

  async function unlink(reference: IssueReferenceView): Promise<void> {
    setBusy(true);
    try {
      await vcsApi.removeReference(issueId, reference.id);
      refresh();
    } catch (error) {
      onError(error instanceof Error ? error.message : 'Could not unlink the reference');
    } finally {
      setBusy(false);
    }
  }

  async function addReference(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (draftRef.trim().length === 0 || draftRepositoryId.length === 0) return;
    setBusy(true);
    try {
      await vcsApi.addReference(issueId, {
        repositoryId: Number(draftRepositoryId),
        kind: draftKind,
        ref: draftRef.trim(),
        headSha: null,
        title: '',
        state: 'open',
        url: null,
      });
      setDraftRef('');
      setAdding(false);
      refresh();
    } catch (error) {
      onError(error instanceof Error ? error.message : 'Could not link the reference');
    } finally {
      setBusy(false);
    }
  }

  async function runPreview(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    const repository = repositories[0];
    if (!repository || previewBranch.trim().length === 0) return;
    try {
      setPreviewResult(await vcsApi.previewBranch(projectId, repository.id, previewBranch.trim()));
    } catch (error) {
      onError(error instanceof Error ? error.message : 'Could not preview the branch name');
    }
  }

  const grouped = KIND_ORDER.map((kind) => ({
    kind,
    items: references.filter((reference) => reference.kind === kind),
  })).filter((group) => group.items.length > 0);

  return (
    <section className="card card-pad stack" aria-label="Development">
      <header className="row-between">
        <h2>Development</h2>
        {summary && summary.branches + summary.commits + summary.mergeRequests > 0 ? (
          <span className="subtle">
            {summary.branches} branch{summary.branches === 1 ? '' : 'es'} ·{' '}
            {summary.mergeRequests} MR{summary.mergeRequests === 1 ? '' : 's'}
            {summary.merged > 0 ? ` · ${summary.merged} merged` : ''}
          </span>
        ) : null}
      </header>

      {query.isLoading && references.length === 0 ? <Spinner label="Loading references" /> : null}

      {!query.isLoading && references.length === 0 && !adding ? (
        <EmptyState
          title="No linked work"
          description="Link a branch or pull request, or set up a naming rule so branches are linked automatically."
        />
      ) : null}

      {grouped.map((group) => (
        <div key={group.kind} className="stack-xs">
          <h3 className="subtle">{REFERENCE_KIND_LABEL[group.kind]}</h3>
          <ul className="list-plain stack-xs">
            {group.items.map((reference) => (
              <li key={reference.id} className="row-between reference-row">
                <span className="row gap-sm" style={{ minWidth: 0 }}>
                  <Badge tone={toneFor(reference)}>{reference.state}</Badge>
                  {reference.url ? (
                    <a
                      href={reference.url}
                      target="_blank"
                      rel="noreferrer noopener"
                      className="truncate"
                      title={reference.ref}
                    >
                      {reference.ref}
                    </a>
                  ) : (
                    <span className="truncate" title={reference.ref}>
                      {reference.ref}
                    </span>
                  )}
                  {reference.headSha ? (
                    <code className="subtle">{reference.headSha.slice(0, 7)}</code>
                  ) : null}
                  {reference.autoDetected ? (
                    <span className="subtle" title="Linked automatically by a naming rule">
                      auto
                    </span>
                  ) : null}
                </span>
                <span className="row gap-xs">
                  <span className="subtle">{formatRelative(reference.updatedAt)}</span>
                  {!reference.isMerged && reference.kind !== 'file' ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={busy}
                      onClick={() => void markMerged(reference)}
                      aria-label={`Mark ${reference.ref} as merged`}
                    >
                      Mark merged
                    </Button>
                  ) : null}
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={busy}
                    onClick={() => void unlink(reference)}
                    aria-label={`Unlink ${reference.ref}`}
                  >
                    Unlink
                  </Button>
                </span>
              </li>
            ))}
          </ul>
        </div>
      ))}

      {adding ? (
        <form className="stack-xs" onSubmit={(event) => void addReference(event)}>
          <label htmlFor="reference-repository">Repository</label>
          <select
            id="reference-repository"
            value={draftRepositoryId}
            onChange={(event) => setDraftRepositoryId(event.target.value)}
            required
          >
            <option value="">Choose a repository…</option>
            {repositories.map((repository) => (
              <option key={repository.id} value={repository.id}>
                {repository.name}
              </option>
            ))}
          </select>

          <label htmlFor="reference-kind">Kind</label>
          <select
            id="reference-kind"
            value={draftKind}
            onChange={(event) => setDraftKind(event.target.value as ReferenceKind)}
          >
            {KIND_ORDER.map((kind) => (
              <option key={kind} value={kind}>
                {REFERENCE_KIND_LABEL[kind]}
              </option>
            ))}
          </select>

          <label htmlFor="reference-ref">Ref</label>
          <input
            id="reference-ref"
            value={draftRef}
            onChange={(event) => setDraftRef(event.target.value)}
            placeholder="feature/PROJ-42-add-login or !123"
            required
          />

          <div className="row gap-xs">
            <Button type="submit" size="sm" disabled={busy}>
              Link
            </Button>
            <Button type="button" variant="ghost" size="sm" onClick={() => setAdding(false)}>
              Cancel
            </Button>
          </div>
        </form>
      ) : (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setAdding(true)}
          disabled={repositories.length === 0}
          title={repositories.length === 0 ? 'Add a repository in project settings first' : undefined}
        >
          Link a branch or pull request
        </Button>
      )}

      {repositories.length > 0 ? (
        <details className="stack-xs">
          <summary className="subtle">Check a branch name</summary>
          <form className="row gap-xs" onSubmit={(event) => void runPreview(event)}>
            <label className="sr-only" htmlFor="branch-preview">
              Branch name to check
            </label>
            <input
              id="branch-preview"
              value={previewBranch}
              onChange={(event) => setPreviewBranch(event.target.value)}
              placeholder="feature/PROJ-42-add-login"
            />
            <Button type="submit" size="sm">
              Check
            </Button>
          </form>
          {previewResult ? (
            previewResult.issue ? (
              <p className="subtle">
                Resolves to <strong>{previewResult.issue.key}</strong> — {previewResult.issue.title}
              </p>
            ) : previewResult.issueKey ? (
              <p className="subtle">
                Resolves to <strong>{previewResult.issueKey}</strong>, but no such issue exists here.
              </p>
            ) : (
              <p className="subtle">No naming rule matches this branch.</p>
            )
          ) : null}
        </details>
      ) : null}
    </section>
  );
}

export default DevelopmentPanel;
