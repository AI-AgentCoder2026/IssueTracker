/**
 * Audit trail viewer.
 *
 * The guarantee here is that entries cannot be edited or deleted, and the
 * strongest evidence of that is the chain check: every row hashes its own
 * fields *and* the previous row's hash, so altering anything out of band
 * breaks the link. The chain is therefore verified on demand rather than
 * assumed, and the result is stated plainly -- a green "valid" on this page
 * means the whole history was recomputed, not that a flag was set.
 */

import { useState } from 'react';
import { useMutation, useQuery } from '../api/hooks';
import { auditApi, type AuditEntry } from '../api/repo';
import { Badge } from '../components/Badge';
import { Button } from '../components/Button';
import { EmptyState, ErrorState } from '../components/EmptyState';
import { Field } from '../components/Select';
import { SkeletonRows } from '../components/Skeleton';
import { DataTable, type Column } from '../components/Table';
import { formatRelative } from '../lib/format';

function isDestructive(action: string): boolean {
  return /delete|remove|archive|revoke|dismiss|unlink|clear/.test(action);
}

const ACTION_TONE = (action: string): 'danger' | 'neutral' => (isDestructive(action) ? 'danger' : 'neutral');

export function AuditViewer(): JSX.Element {
  const [action, setAction] = useState('');
  const [entityType, setEntityType] = useState('');
  const [actorId, setActorId] = useState('');
  const [cursor, setCursor] = useState<number | null>(null);

  const query = useQuery<{ entries: AuditEntry[]; total: number; nextCursor: number | null }>(
    (signal) =>
      auditApi.list(
        {
          action: action.trim() === '' ? undefined : action.trim(),
          entityType: entityType.trim() === '' ? undefined : entityType.trim(),
          actorId: actorId.trim() === '' ? undefined : Number(actorId.trim()),
          limit: 50,
          cursor: cursor ?? undefined,
        },
        signal,
      ),
    [action, entityType, actorId, cursor],
  );

  // A mutation has no cached data, so the verification result is held here.
  const [verification, setVerification] = useState<{
    valid: boolean;
    checked: number;
    brokenAt: number | null;
    message: string;
  } | null>(null);

  const verify = useMutation<void, void>(
    () => auditApi.verifyChain().then((result) => setVerification(result)),
    {},
  );

  if (query.error !== null) return <ErrorState error={query.error} onRetry={query.refetch} />;

  const entries = query.data?.entries ?? [];

  const columns: Column<AuditEntry>[] = [
    {
      key: 'when',
      header: 'When',
      render: (row) => (
        <span className="nowrap" title={row.createdAt}>
          {formatRelative(row.createdAt)}
        </span>
      ),
    },
    {
      key: 'actor',
      header: 'Actor',
      render: (row) => (
        <span>
          {row.actorName}
          {row.ipAddress !== '' ? (
            <span className="subtle"> · {row.ipAddress}</span>
          ) : null}
        </span>
      ),
    },
    {
      key: 'action',
      header: 'Action',
      render: (row) => <Badge tone={ACTION_TONE(row.action)}>{row.action}</Badge>,
    },
    {
      key: 'entity',
      header: 'Entity',
      render: (row) => (
        <span className="mono">
          {row.entityType}
          {row.entityId === null ? '' : `#${row.entityId}`}
        </span>
      ),
    },
    {
      key: 'hash',
      header: 'Chain',
      render: (row) => (
        <span className="mono subtle" title={`prev ${row.prevHash ?? '—'}\nthis ${row.rowHash}`}>
          {row.rowHash.slice(0, 10)}…
        </span>
      ),
    },
  ];

  return (
    <div className="stack">
      <header className="row-between">
        <div>
          <h1>Audit trail</h1>
          <p className="subtle">
            {query.data === null
              ? 'Every state change, append-only.'
              : `${query.data.total} entries matching` +
                (query.data.total > entries.length ? ` · showing ${entries.length}` : '')}
          </p>
        </div>
        <div className="row" style={{ gap: 'var(--space-2)' }}>
          {verification ? (
            <Badge tone={verification.valid ? 'success' : 'danger'} title={verification.message}>
              {verification.valid
                ? `chain intact · ${verification.checked} checked`
                : `chain broken at #${verification.brokenAt}`}
            </Badge>
          ) : null}
          <Button
            onClick={() => verify.mutate(undefined as never)}
            loading={verify.isPending}
            title="Recompute every row hash and confirm each links to the one before it"
          >
            Verify chain
          </Button>
        </div>
      </header>

      {verification && !verification.valid ? (
        <div className="card card-pad" role="alert">
          <strong>The audit chain does not verify.</strong>
          <p className="subtle">{verification.message}</p>
        </div>
      ) : null}

      <div className="filter-bar">
        <Field label="Action" htmlFor="audit-action" hint="Substring, e.g. issue.deleted">
          <input
            id="audit-action"
            className="input"
            value={action}
            onChange={(event) => {
              setAction(event.target.value);
              setCursor(null);
            }}
          />
        </Field>
        <Field label="Entity type" htmlFor="audit-entity" hint="e.g. issue, project_member">
          <input
            id="audit-entity"
            className="input"
            value={entityType}
            onChange={(event) => {
              setEntityType(event.target.value);
              setCursor(null);
            }}
          />
        </Field>
        <Field label="Actor id" htmlFor="audit-actor">
          <input
            id="audit-actor"
            className="input"
            inputMode="numeric"
            value={actorId}
            onChange={(event) => {
              setActorId(event.target.value);
              setCursor(null);
            }}
          />
        </Field>
      </div>

      {query.isLoading ? (
        <SkeletonRows rows={8} height="36px" />
      ) : entries.length === 0 ? (
        <EmptyState
          icon="📜"
          title="No matching entries"
          description="Widen the filters, or make a change and come back."
        />
      ) : (
        <>
          <DataTable
            caption="Audit entries, newest first"
            columns={columns}
            rows={entries}
            rowKey={(row) => row.id}
          />
          <div className="row" style={{ gap: 'var(--space-2)' }}>
            {cursor === null ? null : (
              <Button variant="ghost" onClick={() => setCursor(null)}>
                First page
              </Button>
            )}
            <Button
              variant="ghost"
              disabled={query.data?.nextCursor === null || query.data === null}
              onClick={() => setCursor(query.data?.nextCursor ?? null)}
            >
              Older
            </Button>
            <span className="subtle">
              {cursor === null ? 'Newest first' : 'Older page'} · {entries.length} shown
            </span>
          </div>
        </>
      )}

      <p className="subtle">
        Entries cannot be edited or deleted: the database rejects both, and each row's hash
        covers the row before it. {verification === null ? 'Run the chain check to recompute every row.' : `Last check covered ${verification.checked} rows.`}
      </p>
    </div>
  );
}
