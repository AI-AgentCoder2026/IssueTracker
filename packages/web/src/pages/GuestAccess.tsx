/**
 * Guest access: issue time-bound guest links.
 *
 * A guest can be scoped to one issue, limited to a role, allowed to comment, and
 * capped by an expiry or a use count. The plaintext token is shown exactly once,
 * at creation; the list only ever shows metadata and `tokenHash` is never sent to
 * the browser.
 */

import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { useMutation, useQuery } from '../api/hooks';
import { ApiError } from '../api/client';
import { userApi } from '../api/repo';
import { asProjectId, type CreateGuestTokenInput, type GuestToken, type GuestTokenCreated } from '../api/types';
import { Badge } from '../components/Badge';
import { Button } from '../components/Button';
import { EmptyState, ErrorState } from '../components/EmptyState';
import { useConfirm } from '../components/Modal';
import { Field, Select } from '../components/Select';
import { SkeletonRows } from '../components/Skeleton';
import { DataTable, type Column } from '../components/Table';
import { useToast } from '../components/Toast';
import { formatDateTime, formatRelative } from '../lib/format';

function defaultExpiry(): string {
  const date = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  return date.toISOString().slice(0, 10);
}

export function GuestAccess(): JSX.Element {
  const params = useParams();
  const projectId = asProjectId(Number(params.projectId));
  const toast = useToast();
  const { confirm, dialog } = useConfirm();
  const [issued, setIssued] = useState<{ label: string; url: string } | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [draft, setDraft] = useState<CreateGuestTokenInput>({
    issueId: null,
    label: 'Reviewer',
    role: 'viewer',
    canComment: false,
    expiresAt: defaultExpiry(),
    maxUses: null,
  });

  const tokensQuery = useQuery<GuestToken[]>((signal) => userApi.guestTokens(projectId, signal), [projectId]);

  const create = useMutation<CreateGuestTokenInput, GuestTokenCreated>(
    (input) => userApi.createGuestToken(projectId, input),
    {
      onSuccess: (result) => {
        setFieldErrors({});
        toast.success('Guest link created');
        if (result.tokenValue !== null) {
          setIssued({
            label: result.token.label,
            url: `${window.location.origin}/login?guest=${encodeURIComponent(result.tokenValue)}`,
          });
        }
        tokensQuery.refetch();
      },
      onError: (error) => {
        if (error instanceof ApiError) {
          const next: Record<string, string> = {};
          for (const field of error.fields) next[field.path] = field.message;
          setFieldErrors(next);
        }
        toast.apiError(error);
      },
    },
  );

  const tokens = tokensQuery.data ?? [];

  const columns: ReadonlyArray<Column<GuestToken>> = [
    { key: 'label', header: 'Label', render: (token) => <strong>{token.label}</strong> },
    {
      key: 'scope',
      header: 'Scope',
      render: (token) => (
        <span className="row" style={{ gap: 4 }}>
          <Badge>{token.role}</Badge>
          {token.canComment ? <Badge tone="accent">can comment</Badge> : null}
          {token.issueId === null ? (
            <span className="subtle">whole project</span>
          ) : (
            <a href={`/p/${projectId}/issues/${token.issueId}`} className="subtle">
              issue #{token.issueId}
            </a>
          )}
        </span>
      ),
    },
    {
      key: 'expiry',
      header: 'Expires',
      render: (token) => (
        <span className="nowrap">
          {formatDateTime(token.expiresAt)}
          {token.maxUses === null ? null : (
            <span className="subtle"> · {token.useCount}/{token.maxUses} uses</span>
          )}
        </span>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      width: '120px',
      render: (token) => {
        if (token.revokedAt !== null) return <Badge tone="danger">revoked</Badge>;
        if (new Date(token.expiresAt).getTime() < Date.now()) return <Badge tone="warning">expired</Badge>;
        return <Badge tone="success">active</Badge>;
      },
    },
    {
      key: 'created',
      header: 'Created',
      render: (token) => <span className="subtle nowrap">{formatRelative(token.createdAt)}</span>,
    },
    {
      key: 'actions',
      header: <span className="visually-hidden">Actions</span>,
      width: '110px',
      render: (token) => (
        <Button
          size="sm"
          variant="ghost"
          aria-label={`Revoke guest link ${token.label}`}
          disabled={token.revokedAt !== null}
          onClick={async () => {
            const ok = await confirm({
              title: 'Revoke guest link',
              message: `Revoke “${token.label}”? Anyone holding the link loses access immediately.`,
              confirmLabel: 'Revoke',
              destructive: true,
            });
            if (!ok) return;
            try {
              await userApi.revokeGuestToken(projectId, token.id);
              toast.success('Guest link revoked');
              tokensQuery.refetch();
            } catch (error) {
              toast.apiError(error);
            }
          }}
        >
          Revoke
        </Button>
      ),
    },
  ];

  return (
    <div className="stack">
      <section className="card card-pad stack" aria-label="Create a guest link">
        <h2>Create a guest link</h2>
        <p className="subtle">
          Guests see only what their role allows. The link is shown once at creation and is never stored in
          readable form.
        </p>
        <form
          className="row"
          style={{ gap: 'var(--space-3)', alignItems: 'flex-end', flexWrap: 'wrap' }}
          onSubmit={(event) => {
            event.preventDefault();
            setFieldErrors({});
            if (draft.label.trim() === '') {
              setFieldErrors({ label: 'Give the link a label so you can recognise it later.' });
              return;
            }
            void create.mutate({ ...draft, expiresAt: new Date(`${draft.expiresAt}T23:59:59Z`).toISOString() });
          }}
          noValidate
        >
          <Field label="Label" htmlFor="guest-label" error={fieldErrors.label}>
            <input
              id="guest-label"
              className="input"
              value={draft.label}
              maxLength={120}
              aria-invalid={fieldErrors.label !== undefined}
              onChange={(event) => setDraft({ ...draft, label: event.target.value })}
            />
          </Field>
          <Select
            label="Role"
            value={draft.role}
            options={[
              { value: 'viewer' as const, label: 'Viewer — read only' },
              { value: 'reporter' as const, label: 'Reporter — can file and comment' },
            ]}
            onChange={(role) => setDraft({ ...draft, role })}
          />
          <Field label="Issue id" htmlFor="guest-issue" hint="Blank = whole project" error={fieldErrors.issueId}>
            <input
              id="guest-issue"
              className="input"
              inputMode="numeric"
              style={{ width: 110 }}
              value={draft.issueId ?? ''}
              onChange={(event) =>
                setDraft({ ...draft, issueId: event.target.value === '' ? null : Number(event.target.value) })
              }
            />
          </Field>
          <Field label="Expires" htmlFor="guest-expiry" error={fieldErrors.expiresAt}>
            <input
              id="guest-expiry"
              className="input"
              type="date"
              value={draft.expiresAt.slice(0, 10)}
              onChange={(event) => setDraft({ ...draft, expiresAt: event.target.value })}
            />
          </Field>
          <Field label="Max uses" htmlFor="guest-max" hint="Blank = unlimited" error={fieldErrors.maxUses}>
            <input
              id="guest-max"
              className="input"
              type="number"
              min={1}
              style={{ width: 100 }}
              value={draft.maxUses ?? ''}
              onChange={(event) =>
                setDraft({ ...draft, maxUses: event.target.value === '' ? null : Number(event.target.value) })
              }
            />
          </Field>
          <label className="checkbox" style={{ height: 32 }}>
            <input
              type="checkbox"
              checked={draft.canComment}
              onChange={(event) => setDraft({ ...draft, canComment: event.target.checked })}
            />
            Can comment
          </label>
          <Button type="submit" variant="primary" loading={create.isPending}>
            Create link
          </Button>
        </form>

        {issued !== null ? (
          <div className="card card-pad stack-sm" role="status">
            <strong>Copy this link now — it is shown only once.</strong>
            <div className="copy-field">
              <input className="input" readOnly value={issued.url} aria-label="Guest link" />
              <Button
                onClick={() => {
                  void navigator.clipboard
                    .writeText(issued.url)
                    .then(() => toast.success('Link copied'))
                    .catch(() => toast.error('Copy failed — select the text and copy manually.'));
                }}
              >
                Copy
              </Button>
            </div>
            <p className="subtle">
              {issued.label} · anyone with this link can redeem it until it expires or is revoked.
            </p>
          </div>
        ) : null}
      </section>

      <section className="card card-pad stack" aria-label="Existing guest links">
        <h2>Guest links</h2>
        {tokensQuery.error !== null ? (
          <ErrorState error={tokensQuery.error} onRetry={tokensQuery.refetch} />
        ) : tokensQuery.isLoading ? (
          <SkeletonRows rows={3} height="44px" />
        ) : tokens.length === 0 ? (
          <EmptyState
            icon="🔑"
            title="No guest links"
            description="Create one to share a read-only view with someone outside the project."
          />
        ) : (
          <DataTable
            caption="Guest access links for this project"
            columns={columns}
            rows={tokens}
            rowKey={(token) => token.id}
            emptyMessage="No guest links"
          />
        )}
      </section>

      {dialog}
    </div>
  );
}
