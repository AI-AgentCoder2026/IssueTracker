/** Workflow editor: statuses (name, colour, category, WIP limit) and transitions. */

import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { useMutation, useQuery } from '../api/hooks';
import { ApiError } from '../api/client';
import { workflowApi, type StatusDraft } from '../api/repo';
import {
  ISSUE_STATES,
  STATUS_CATEGORIES,
  asProjectId,
  type IssueState,
  type StatusCategory,
  type Workflow,
  type WorkflowStatus,
} from '../api/types';
import { Badge } from '../components/Badge';
import { Button } from '../components/Button';
import { EmptyState, ErrorState } from '../components/EmptyState';
import { useConfirm } from '../components/Modal';
import { Field, Select } from '../components/Select';
import { SkeletonRows } from '../components/Skeleton';
import { useToast } from '../components/Toast';

const DEFAULT_DRAFT: StatusDraft = {
  key: '',
  name: '',
  state: 'open',
  category: 'unstarted',
  color: '#3b82f6',
  description: '',
  position: 0,
  isResolution: false,
  isClosed: false,
  isDone: false,
  wipLimit: null,
};

export function SettingsWorkflow(): JSX.Element {
  const params = useParams();
  const projectId = asProjectId(Number(params.projectId));
  const toast = useToast();
  const { confirm, dialog } = useConfirm();
  const workflowQuery = useQuery<Workflow>((signal) => workflowApi.get(projectId, signal), [projectId]);
  const [draft, setDraft] = useState<StatusDraft>(DEFAULT_DRAFT);
  const [transitionDraft, setTransitionDraft] = useState({ from: '', to: '', name: '' });
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const refetch = workflowQuery.refetch;

  const createStatus = useMutation<StatusDraft, WorkflowStatus>(
    (input) => workflowApi.createStatus(projectId, input),
    {
      onSuccess: (status) => {
        setDraft(DEFAULT_DRAFT);
        setFieldErrors({});
        toast.success(`Status “${status.name}” added`);
        refetch();
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

  const patchStatus = useMutation<{ id: number; patch: Partial<StatusDraft> }, unknown>(
    ({ id, patch }) => workflowApi.updateStatus(projectId, id, patch),
    {
      onSuccess: () => refetch(),
      onError: (error) => toast.apiError(error),
    },
  );

  const createTransition = useMutation<
    { fromStatusId: number | null; toStatusId: number; name: string; description: string; requiredPermission: string | null },
    unknown
  >(
    (input) => workflowApi.createTransition(projectId, input),
    {
      onSuccess: () => {
        setTransitionDraft({ from: '', to: '', name: '' });
        toast.success('Transition added');
        refetch();
      },
      onError: (error) => toast.apiError(error),
    },
  );

  if (workflowQuery.error !== null) {
    return <ErrorState error={workflowQuery.error} onRetry={workflowQuery.refetch} />;
  }
  if (workflowQuery.isLoading) return <SkeletonRows rows={6} height="48px" />;

  const workflow = workflowQuery.data;
  const statuses = workflow?.statuses ?? [];
  const transitions = workflow?.transitions ?? [];
  const statusName = (id: number | null): string =>
    id === null ? 'Any status' : (statuses.find((status) => status.id === id)?.name ?? `#${id}`);

  return (
    <div className="stack">
      <section className="card card-pad stack" aria-label="Statuses">
        <div className="row-between">
          <h2>Statuses</h2>
          <Badge>{statuses.length} columns</Badge>
        </div>
        <p className="subtle">
          The board renders one column per status, in position order. A WIP limit highlights the column
          once it is exceeded.
        </p>

        {statuses.length === 0 ? (
          <EmptyState icon="🧭" title="No statuses defined" description="Add the first status to start the workflow." />
        ) : (
          <div className="link-list">
            {statuses.map((status) => (
              <StatusRow
                key={status.id}
                status={status}
                busy={patchStatus.isPending}
                onPatch={(patch) => void patchStatus.mutate({ id: status.id as number, patch })}
                onMove={(delta) =>
                  void patchStatus.mutate({
                    id: status.id as number,
                    patch: { position: Math.max(0, status.position + delta) },
                  })
                }
                onDelete={async () => {
                  const ok = await confirm({
                    title: 'Delete status',
                    message: `Delete “${status.name}”? Issues currently in it must be moved first.`,
                    confirmLabel: 'Delete',
                    destructive: true,
                  });
                  if (!ok) return;
                  try {
                    await workflowApi.removeStatus(projectId, status.id as number);
                    toast.success('Status deleted');
                    refetch();
                  } catch (error) {
                    toast.apiError(error);
                  }
                }}
              />
            ))}
          </div>
        )}

        <form
          className="row"
          style={{ alignItems: 'flex-end', gap: 'var(--space-3)', flexWrap: 'wrap' }}
          onSubmit={(event) => {
            event.preventDefault();
            setFieldErrors({});
            if (!/^[a-z0-9_]+$/.test(draft.key) || draft.name.trim() === '') {
              setFieldErrors({
                key:
                  draft.key === ''
                    ? 'A key is required.'
                    : 'Key must be lowercase letters, digits and underscores.',
              });
              return;
            }
            void createStatus.mutate({ ...draft, position: draft.position || statuses.length });
          }}
          noValidate
        >
          <Field label="Key" htmlFor="status-key" error={fieldErrors.key}>
            <input
              id="status-key"
              className="input"
              value={draft.key}
              onChange={(event) => setDraft({ ...draft, key: event.target.value.toLowerCase() })}
            />
          </Field>
          <Field label="Name" htmlFor="status-name" error={fieldErrors.name}>
            <input
              id="status-name"
              className="input"
              value={draft.name}
              onChange={(event) => setDraft({ ...draft, name: event.target.value })}
            />
          </Field>
          <Select
            label="Category"
            value={draft.category}
            options={STATUS_CATEGORIES.map((category: StatusCategory) => ({
              value: category,
              label: category,
            }))}
            onChange={(value) => setDraft({ ...draft, category: value })}
          />
          <Select
            label="State"
            value={draft.state}
            options={ISSUE_STATES.map((state) => ({ value: state, label: state.replace('_', ' ') }))}
            onChange={(value) => setDraft({ ...draft, state: value })}
          />
          <Field label="Colour" htmlFor="status-color">
            <input
              id="status-color"
              className="input"
              type="color"
              value={draft.color}
              style={{ width: 60, padding: 2 }}
              onChange={(event) => setDraft({ ...draft, color: event.target.value })}
            />
          </Field>
          <Field label="WIP limit" htmlFor="status-wip" error={fieldErrors.wipLimit} hint="Blank = none">
            <input
              id="status-wip"
              className="input"
              type="number"
              min={1}
              value={draft.wipLimit ?? ''}
              style={{ width: 90 }}
              onChange={(event) =>
                setDraft({ ...draft, wipLimit: event.target.value === '' ? null : Number(event.target.value) })
              }
            />
          </Field>
          <Button type="submit" variant="primary" loading={createStatus.isPending}>
            Add status
          </Button>
        </form>
      </section>

      <section className="card card-pad stack" aria-label="Transitions">
        <h2>Transitions</h2>
        <p className="subtle">
          These become the status buttons on an issue. “Any status” makes the transition available from
          every column.
        </p>
        {transitions.length === 0 ? (
          <EmptyState icon="➡" title="No transitions defined" description="Issues cannot change status until a transition exists." />
        ) : (
          <div className="link-list">
            {transitions.map((transition) => (
              <div key={transition.id} className="link-row">
                <span className="truncate">
                  <strong>{transition.name}</strong>{' '}
                  <span className="subtle">
                    {statusName(transition.fromStatusId)} → {statusName(transition.toStatusId)}
                  </span>
                  {transition.description === '' ? null : (
                    <span className="subtle"> · {transition.description}</span>
                  )}
                </span>
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label={`Delete transition ${transition.name}`}
                  onClick={async () => {
                    const ok = await confirm({
                      title: 'Delete transition',
                      message: `Delete “${transition.name}”?`,
                      confirmLabel: 'Delete',
                      destructive: true,
                    });
                    if (!ok) return;
                    try {
                      await workflowApi.removeTransition(projectId, transition.id as number);
                      toast.success('Transition deleted');
                      refetch();
                    } catch (error) {
                      toast.apiError(error);
                    }
                  }}
                >
                  Delete
                </Button>
              </div>
            ))}
          </div>
        )}

        <form
          className="row"
          style={{ alignItems: 'flex-end', gap: 'var(--space-3)' }}
          onSubmit={(event) => {
            event.preventDefault();
            if (transitionDraft.to === '') {
              setFieldErrors({ toStatusId: 'Choose a destination status.' });
              return;
            }
            const from = transitionDraft.from === '' ? null : Number(transitionDraft.from);
            const to = Number(transitionDraft.to);
            void createTransition.mutate({
              fromStatusId: from,
              toStatusId: to,
              name: transitionDraft.name.trim() === '' ? statusName(to) : transitionDraft.name.trim(),
              description: '',
              requiredPermission: null,
            });
          }}
          noValidate
        >
          <Select
            label="From"
            value={transitionDraft.from}
            options={statuses.map((status) => ({ value: String(status.id), label: status.name }))}
            placeholder="Any status"
            onChange={(value) => setTransitionDraft({ ...transitionDraft, from: value })}
          />
          <Select
            label="To"
            value={transitionDraft.to}
            options={statuses.map((status) => ({ value: String(status.id), label: status.name }))}
            placeholder="Choose a status"
            error={fieldErrors.toStatusId}
            onChange={(value) => setTransitionDraft({ ...transitionDraft, to: value })}
          />
          <Field label="Button label" htmlFor="transition-name" hint="Defaults to the destination name">
            <input
              id="transition-name"
              className="input"
              value={transitionDraft.name}
              onChange={(event) => setTransitionDraft({ ...transitionDraft, name: event.target.value })}
            />
          </Field>
          <Button type="submit" variant="primary" loading={createTransition.isPending}>
            Add transition
          </Button>
        </form>
      </section>

      {dialog}
    </div>
  );
}

function StatusRow({
  status,
  busy,
  onPatch,
  onMove,
  onDelete,
}: {
  status: WorkflowStatus;
  busy: boolean;
  onPatch: (patch: Partial<StatusDraft>) => void;
  onMove: (delta: number) => void;
  onDelete: () => Promise<void>;
}): JSX.Element {
  return (
    <div className="link-row" style={{ flexWrap: 'wrap', gap: 'var(--space-3)' }}>
      <span className="row grow" style={{ gap: 8, minWidth: 180 }}>
        <span className="status-dot" style={{ background: status.color }} aria-hidden="true" />
        <span>
          <span style={{ fontWeight: 500 }}>{status.name}</span>{' '}
          <span className="subtle mono">{status.key}</span>
        </span>
        <Badge>{status.category}</Badge>
        {status.isResolution ? <Badge tone="success">resolution</Badge> : null}
        {status.isClosed ? <Badge tone="info">closed</Badge> : null}
        {status.isDone ? <Badge tone="accent">done</Badge> : null}
        {status.wipLimit !== null ? <Badge tone="warning">WIP {status.wipLimit}</Badge> : null}
      </span>
      <span className="row" style={{ gap: 4, flexWrap: 'wrap' }}>
        <Select
          label={`State for ${status.name}`}
          hideLabel
          value={status.state}
          options={ISSUE_STATES.map((state) => ({ value: state, label: state.replace('_', ' ') }))}
          onChange={(state: IssueState) => onPatch({ state })}
        />
        <Select
          label={`Category for ${status.name}`}
          hideLabel
          value={status.category}
          options={STATUS_CATEGORIES.map((category: StatusCategory) => ({ value: category, label: category }))}
          onChange={(category: StatusCategory) => onPatch({ category })}
        />
        <input
          type="color"
          className="input"
          aria-label={`Colour for ${status.name}`}
          value={status.color}
          style={{ width: 48, padding: 2 }}
          onChange={(event) => onPatch({ color: event.target.value })}
        />
        <input
          type="number"
          className="input"
          aria-label={`WIP limit for ${status.name}`}
          placeholder="WIP"
          min={1}
          defaultValue={status.wipLimit ?? ''}
          style={{ width: 76 }}
          onBlur={(event) =>
            onPatch({ wipLimit: event.target.value === '' ? null : Number(event.target.value) })
          }
        />
        <Button size="sm" onClick={() => onMove(-1)} disabled={busy} aria-label={`Move ${status.name} earlier`}>
          ↑
        </Button>
        <Button size="sm" onClick={() => onMove(1)} disabled={busy} aria-label={`Move ${status.name} later`}>
          ↓
        </Button>
        <Button size="sm" variant="ghost" onClick={() => void onDelete()} disabled={busy}>
          Delete
        </Button>
      </span>
    </div>
  );
}
