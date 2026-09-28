/**
 * Outgoing webhooks.
 *
 * Delivery, signing and retry all worked before this screen existed; what was
 * missing was any way to see it working or to configure it. The delivery log is
 * the point -- a webhook that silently stops firing is indistinguishable from
 * one that never fired, and "test" is how you tell the difference without
 * waiting for a real event.
 *
 * The target must be https, except on localhost. That rule is enforced by the
 * server and repeated here so the form explains it rather than just rejecting.
 */

import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { useMutation, useQuery } from '../api/hooks';
import { asRecord } from '../api/normalize';
import { webhookApi, type WebhookDelivery, type WebhookSummary } from '../api/repo';
import { asProjectId } from '../api/types';
import { Badge } from '../components/Badge';
import { Button } from '../components/Button';
import { EmptyState, ErrorState } from '../components/EmptyState';
import { Field } from '../components/Select';
import { useConfirm } from '../components/Modal';
import { SkeletonRows } from '../components/Skeleton';
import { DataTable, type Column } from '../components/Table';
import { useToast } from '../components/Toast';
import { formatDateTime, formatDuration, formatRelative } from '../lib/format';

/** Mirrors the server's EVENT_NAMES; the schema rejects anything else. */
const EVENTS = [
  'issue.created',
  'issue.updated',
  'issue.transitioned',
  'issue.deleted',
  'issue.archived',
  'comment.created',
  'gitlab.sync',
  'gitlab.conflict',
  'ping',
] as const;

const STATUS_TONE: Record<string, 'success' | 'danger' | 'warning' | 'neutral'> = {
  succeeded: 'success',
  delivered: 'success',
  failed: 'danger',
  pending: 'warning',
  retrying: 'warning',
};

function WebhookRow({
  webhook,
  onChanged,
}: {
  webhook: WebhookSummary;
  onChanged: () => void;
}): JSX.Element {
  const toast = useToast();
  const { confirm, dialog } = useConfirm();
  const [showLog, setShowLog] = useState(false);

  const deliveriesQuery = useQuery<WebhookDelivery[]>(
    (signal) => webhookApi.deliveries(webhook.projectId, webhook.id, signal),
    [webhook.id, showLog],
    { enabled: showLog },
  );

  const test = useMutation<void, WebhookDelivery>(
    () => webhookApi.test(webhook.projectId, webhook.id),
    {
      onSuccess: (delivery) => {
        toast.success(
          delivery.error === null
            ? `Test delivered (${delivery.statusCode ?? 'no status'})`
            : `Test failed: ${delivery.error}`,
        );
        if (showLog) deliveriesQuery.refetch();
        else onChanged();
      },
      onError: (error) => toast.apiError(error),
    },
  );

  const toggle = useMutation<boolean, unknown>(
    (enabled) => webhookApi.update(webhook.projectId, webhook.id, { enabled }),
    {
      onSuccess: () => {
        onChanged();
        toast.success(webhook.enabled ? 'Webhook disabled' : 'Webhook enabled');
      },
      onError: (error) => toast.apiError(error),
    },
  );

  const columns: Column<WebhookDelivery>[] = [
    { key: 'event', header: 'Event', render: (row) => <span className="mono">{row.event}</span> },
    {
      key: 'status',
      header: 'Status',
      render: (row) => (
        <Badge tone={STATUS_TONE[row.status] ?? 'neutral'}>
          {row.statusCode === null ? row.status : `${row.status} ${row.statusCode}`}
        </Badge>
      ),
    },
    { key: 'attempt', header: 'Attempt', numeric: true, render: (row) => row.attempt },
    {
      key: 'duration',
      header: 'Duration',
      numeric: true,
      render: (row) => (row.durationMs === null ? '—' : formatDuration(row.durationMs)),
    },
    {
      key: 'error',
      header: 'Error',
      render: (row) => <span className="subtle">{row.error ?? '—'}</span>,
    },
    {
      key: 'when',
      header: 'When',
      render: (row) => (
        <span className="nowrap" title={row.createdAt}>
          {formatRelative(row.createdAt)}
        </span>
      ),
    },
  ];

  return (
    <div className="card card-pad stack">
      <div className="row-between">
        <div className="row" style={{ gap: 8 }}>
          <strong>{webhook.name}</strong>
          {webhook.enabled ? (
            <Badge tone="success">enabled</Badge>
          ) : (
            <Badge tone="neutral">disabled</Badge>
          )}
          {webhook.failureCount > 0 ? (
            <Badge tone={webhook.enabled ? 'warning' : 'danger'}>
              {webhook.failureCount} failed
            </Badge>
          ) : null}
          {webhook.disabledAt !== null ? (
            <Badge tone="danger" title={webhook.disabledAt}>
              auto-disabled
            </Badge>
          ) : null}
        </div>
        <div className="row" style={{ gap: 'var(--space-2)' }}>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              void test.mutate(undefined as never);
            }}
            loading={test.isPending}
          >
            Send test
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setShowLog((open) => !open)}
            aria-expanded={showLog}
          >
            {showLog ? 'Hide deliveries' : 'Deliveries'}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => { void toggle.mutate(!webhook.enabled); }}
            loading={toggle.isPending}
          >
            {webhook.enabled ? 'Disable' : 'Enable'}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={async () => {
              const agreed = await confirm({
                title: `Delete "${webhook.name}"?`,
                message:
                  'The endpoint stops receiving events immediately. The signing secret is not shown again, so a replacement will need a new secret.',
                confirmLabel: 'Delete webhook',
                destructive: true,
              });
              if (!agreed) return;
              try {
                await webhookApi.remove(webhook.projectId, webhook.id);
                toast.success('Webhook deleted');
                onChanged();
              } catch (error) {
                toast.apiError(error as never);
              }
            }}
          >
            Delete
          </Button>
        </div>
      </div>

      <p className="subtle mono">{webhook.targetUrl}</p>
      <div className="row" style={{ gap: 4, flexWrap: 'wrap' }}>
        {webhook.events.map((event) => (
          <Badge key={event}>{event}</Badge>
        ))}
      </div>
      <p className="subtle">
        Created {formatDateTime(webhook.createdAt)} · last updated {formatRelative(webhook.updatedAt)}
      </p>

      {showLog ? (
        deliveriesQuery.isLoading ? (
          <SkeletonRows rows={3} height="32px" />
        ) : (deliveriesQuery.data ?? []).length === 0 ? (
          <EmptyState
            icon="📨"
            title="No deliveries yet"
            description="Send a test to see the request the server would make."
          />
        ) : (
          <DataTable
            caption={`Deliveries for ${webhook.name}`}
            columns={columns}
            rows={deliveriesQuery.data ?? []}
            rowKey={(row) => row.id}
          />
        )
      ) : null}

      {dialog}
    </div>
  );
}

export function WebhookSettings(): JSX.Element {
  const params = useParams();
  const projectId = asProjectId(Number(params.projectId));
  const toast = useToast();
  const [name, setName] = useState('');
  const [targetUrl, setTargetUrl] = useState('');
  const [events, setEvents] = useState<string[]>(['issue.created']);
  // The server returns the signing secret only in the creating response. If it
  // is not shown here and now, the receiver can never be configured.
  const [issued, setIssued] = useState<{ name: string; secret: string } | null>(null);

  const listQuery = useQuery<WebhookSummary[]>((signal) => webhookApi.list(projectId, signal), [
    projectId,
  ]);

  const create = useMutation<void, unknown>(
    () => webhookApi.create(projectId, { name, targetUrl, events, enabled: true }),
    {
      onSuccess: (result) => {
        // The route answers `{ webhook: { ... secret } }`.
        const secret = asRecord(asRecord(result)['webhook'])['secret'];
        setIssued(
          typeof secret === 'string' && secret !== ''
            ? { name: name.trim(), secret }
            : null,
        );
        setName('');
        setTargetUrl('');
        setEvents(['issue.created']);
        listQuery.refetch();
        toast.success('Webhook created');
      },
      onError: (error) => toast.apiError(error),
    },
  );

  if (listQuery.error !== null) {
    return <ErrorState error={listQuery.error} onRetry={listQuery.refetch} />;
  }
  if (listQuery.isLoading) return <SkeletonRows rows={3} height="96px" />;

  const webhooks = listQuery.data ?? [];
  const ready = name.trim() !== '' && targetUrl.trim() !== '' && events.length > 0;

  return (
    <div className="stack">
      <header>
        <h1>Webhooks</h1>
        <p className="subtle">
          Outbound events, signed with a per-webhook secret and retried on failure. A
          webhook that keeps failing is disabled automatically.
        </p>
      </header>

      {issued !== null ? (
        <div className="card card-pad stack" role="status">
          <div className="row-between">
            <strong>Signing secret for “{issued.name}”</strong>
            <Button size="sm" variant="ghost" onClick={() => setIssued(null)}>
              Dismiss
            </Button>
          </div>
          <p className="subtle">
            Copy it now. It is shown only in this response and cannot be read again — use it
            as the shared secret your endpoint verifies the signature with.
          </p>
          <code className="mono" style={{ wordBreak: 'break-all' }}>
            {issued.secret}
          </code>
        </div>
      ) : null}

      <section className="card card-pad stack" aria-label="Add a webhook">
        <h2>Add a webhook</h2>
        <div className="row" style={{ gap: 'var(--space-4)', flexWrap: 'wrap' }}>
          <Field label="Name" htmlFor="wh-name">
            <input
              id="wh-name"
              className="input"
              value={name}
              placeholder="Deploy notifications"
              onChange={(event) => setName(event.target.value)}
            />
          </Field>
          <Field
            label="Target URL"
            htmlFor="wh-url"
            hint="Must be https. Plain http is allowed only for localhost."
          >
            <input
              id="wh-url"
              className="input"
              value={targetUrl}
              placeholder="https://example.com/hooks/tracker"
              onChange={(event) => setTargetUrl(event.target.value)}
            />
          </Field>
        </div>
        <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
          {EVENTS.map((event) => (
            <label key={event} className="checkbox">
              <input
                type="checkbox"
                checked={events.includes(event)}
                onChange={(checked) =>
                  setEvents((previous) =>
                    checked
                      ? [...previous, event]
                      : previous.filter((each) => each !== event),
                  )
                }
              />
              {event}
            </label>
          ))}
        </div>
        <div>
          <Button onClick={() => create.mutate(undefined as never)} disabled={!ready} loading={create.isPending}>
            Create webhook
          </Button>
        </div>
      </section>

      {webhooks.length === 0 ? (
        <EmptyState
          icon="📨"
          title="No webhooks yet"
          description="Add one above to broadcast issue and sync events to another service."
        />
      ) : (
        webhooks.map((webhook) => (
          <WebhookRow key={webhook.id} webhook={webhook} onChanged={listQuery.refetch} />
        ))
      )}
    </div>
  );
}
