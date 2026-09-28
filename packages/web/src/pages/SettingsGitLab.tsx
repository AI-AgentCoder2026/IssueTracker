/**
 * GitLab connection panel.
 *
 * Two different settings are called "source of truth" here, and conflating them
 * is the whole reason the second one used to have no control at all:
 *
 *   * `syncMode` is per-connection and decides who wins a conflict -- the
 *     radio group below.
 *   * `sourceOfTruth` is a *project* field deciding where the canonical record
 *     lives: `local` keeps the tracker authoritative and mirrors to GitLab,
 *     `gitlab` makes GitLab the store and the tracker a mirror. This is the
 *     setting behind "use GitLab to store", so it gets its own control.
 *
 * The access token is write-only: only `hasToken` and `tokenHint` are read back.
 */

import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { useMutation, useQuery } from '../api/hooks';
import { ApiError } from '../api/client';
import { gitlabApi, projectApi } from '../api/repo';
import {
  SYNC_MODES,
  SYNC_MODE_DESCRIPTION,
  SYNC_MODE_LABEL,
  asProjectId,
  type GitLabConnectionPublic,
  type SyncConflict,
  type SyncMode,
  type SyncRun,
} from '../api/types';
import { Badge } from '../components/Badge';
import { Button } from '../components/Button';
import { EmptyState, ErrorState } from '../components/EmptyState';
import { useConfirm } from '../components/Modal';
import { Field, Select } from '../components/Select';
import { SkeletonRows } from '../components/Skeleton';
import { DataTable, type Column } from '../components/Table';
import { useToast } from '../components/Toast';
import { formatDateTime, formatRelative } from '../lib/format';

/** Where the canonical record for this project lives. */
const SOURCE_OF_TRUTH: Array<{ value: 'local' | 'gitlab'; label: string; description: string }> = [
  {
    value: 'local',
    label: 'This tracker is the store',
    description:
      'Issues are authoritative here and are mirrored to GitLab. Use this when GitLab is a reporting surface.',
  },
  {
    value: 'gitlab',
    label: 'GitLab is the store',
    description:
      'The GitLab project is authoritative and this tracker mirrors it. Use this when the team works in GitLab.',
  },
];

interface FormState {
  baseUrl: string;
  gitlabProjectPath: string;
  accessToken: string;
  syncMode: SyncMode;
  enabled: boolean;
  syncHierarchy: boolean;
  syncComments: boolean;
  syncLabels: boolean;
  syncIncidents: boolean;
  titlePrefix: string;
}

const EMPTY_FORM: FormState = {
  baseUrl: 'https://gitlab.com',
  gitlabProjectPath: '',
  accessToken: '',
  syncMode: 'bidirectional',
  enabled: true,
  syncHierarchy: true,
  syncComments: true,
  syncLabels: true,
  syncIncidents: false,
  titlePrefix: '',
};

const STATUS_TONE: Record<string, 'success' | 'danger' | 'warning' | 'neutral'> = {
  ok: 'success',
  error: 'danger',
  running: 'warning',
  never: 'neutral',
};

export function SettingsGitLab(): JSX.Element {
  const params = useParams();
  const projectId = asProjectId(Number(params.projectId));
  const toast = useToast();
  const { confirm, dialog } = useConfirm();
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  // The project-level source of truth, which is separate from the connection's
  // sync mode. It is a project field, so it is read and written through the
  // project route rather than the GitLab connection route.
  const projectQuery = useQuery((signal) => projectApi.get(projectId, signal), [projectId]);
  const [sourceOfTruth, setSourceOfTruth] = useState<'local' | 'gitlab'>('local');

  useEffect(() => {
    if (projectQuery.data !== null) setSourceOfTruth(projectQuery.data.sourceOfTruth);
  }, [projectQuery.data]);

  const saveSourceOfTruth = useMutation<'local' | 'gitlab', void>(
    (value) => projectApi.update(projectId, { sourceOfTruth: value }).then(() => undefined),
    {
      onSuccess: () => {
        projectQuery.refetch();
        toast.success(
          sourceOfTruth === 'gitlab'
            ? 'GitLab is now the store for this project'
            : 'This tracker is now the store for this project',
        );
      },
      onError: (error) => toast.apiError(error),
    },
  );

  const connectionQuery = useQuery<GitLabConnectionPublic | null>(
    (signal) => gitlabApi.connection(projectId, signal),
    [projectId],
  );
  const runsQuery = useQuery<SyncRun[]>((signal) => gitlabApi.runs(projectId, signal), [projectId]);
  const conflictsQuery = useQuery<SyncConflict[]>(
    (signal) => gitlabApi.conflicts(projectId, signal),
    [projectId],
  );

  const connection = connectionQuery.data ?? null;

  useEffect(() => {
    if (connection === null) {
      setForm(EMPTY_FORM);
      return;
    }
    setForm({
      baseUrl: connection.baseUrl,
      gitlabProjectPath: connection.gitlabProjectPath,
      accessToken: '',
      syncMode: connection.syncMode,
      enabled: connection.enabled,
      syncHierarchy: connection.syncHierarchy,
      syncComments: connection.syncComments,
      syncLabels: connection.syncLabels,
      syncIncidents: connection.syncIncidents,
      titlePrefix: connection.titlePrefix,
    });
  }, [connection]);

  const save = useMutation<FormState, unknown>(
    (state) => {
      const body: Record<string, unknown> = {
        baseUrl: state.baseUrl,
        gitlabProjectPath: state.gitlabProjectPath,
        syncMode: state.syncMode,
        enabled: state.enabled,
        syncHierarchy: state.syncHierarchy,
        syncComments: state.syncComments,
        syncLabels: state.syncLabels,
        syncIncidents: state.syncIncidents,
        titlePrefix: state.titlePrefix,
      };
      // A blank token means "keep the stored one"; it is only sent when set.
      if (state.accessToken.trim() !== '') body.accessToken = state.accessToken.trim();
      return gitlabApi.save(projectId, body);
    },
    {
      onSuccess: () => {
        setFieldErrors({});
        setForm((current) => ({ ...current, accessToken: '' }));
        toast.success('GitLab connection saved');
        connectionQuery.refetch();
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

  const sync = useMutation<'push' | 'pull' | 'full', unknown>((direction) => gitlabApi.sync(projectId, direction), {
    onSuccess: (_result, direction) => {
      toast.success(`Sync (${direction}) started`);
      runsQuery.refetch();
      connectionQuery.refetch();
    },
    onError: (error) => toast.apiError(error),
  });

  const resolve = useMutation<
    { id: number; resolution: 'kept_local' | 'kept_gitlab' | 'merged' },
    unknown
  >(({ id, resolution }) => gitlabApi.resolveConflict(id, resolution), {
    onSuccess: () => {
      toast.success('Conflict resolved');
      conflictsQuery.refetch();
      connectionQuery.refetch();
    },
    onError: (error) => toast.apiError(error),
  });

  if (connectionQuery.error !== null) {
    return <ErrorState error={connectionQuery.error} onRetry={connectionQuery.refetch} />;
  }

  const openConflicts = (conflictsQuery.data ?? []).filter((conflict) => conflict.resolvedAt === null);

  const runColumns: ReadonlyArray<Column<SyncRun>> = [
    { key: 'started', header: 'Started', render: (run) => formatDateTime(run.startedAt) },
    { key: 'direction', header: 'Direction', render: (run) => run.direction },
    { key: 'trigger', header: 'Trigger', render: (run) => run.trigger },
    {
      key: 'status',
      header: 'Status',
      render: (run) => (
        <span className="row" style={{ gap: 6 }}>
          <Badge tone={STATUS_TONE[run.status] ?? 'neutral'}>{run.status}</Badge>
          {run.message === null ? null : <span className="subtle truncate">{run.message}</span>}
        </span>
      ),
    },
    { key: 'pushed', header: 'Pushed', numeric: true, render: (run) => run.pushed },
    { key: 'pulled', header: 'Pulled', numeric: true, render: (run) => run.pulled },
    { key: 'conflicts', header: 'Conflicts', numeric: true, render: (run) => run.conflicts },
    { key: 'failed', header: 'Failed', numeric: true, render: (run) => run.failed },
  ];

  const conflictColumns: ReadonlyArray<Column<SyncConflict>> = [
    {
      key: 'issue',
      header: 'Issue',
      render: (conflict) => (
        <a href={`/p/${projectId}/issues/${conflict.issueId}`}>{conflict.localIssueKey}</a>
      ),
    },
    { key: 'field', header: 'Field', render: (conflict) => <code>{conflict.field}</code> },
    {
      key: 'values',
      header: 'This tracker vs GitLab',
      render: (conflict) => (
        <span className="stack-sm">
          <span className="truncate">
            <span className="subtle">local: </span>
            {conflict.localValue ?? '—'}
          </span>
          <span className="truncate">
            <span className="subtle">gitlab: </span>
            {conflict.gitlabValue ?? '—'}
          </span>
        </span>
      ),
    },
    {
      key: 'updated',
      header: 'Updated',
      render: (conflict) => (
        <span className="subtle nowrap">
          {formatRelative(conflict.localUpdatedAt)} / {formatRelative(conflict.gitlabUpdatedAt)}
        </span>
      ),
    },
    {
      key: 'actions',
      header: 'Resolve',
      width: '260px',
      render: (conflict) =>
        conflict.resolvedAt === null ? (
          <span className="row" style={{ gap: 4 }}>
            <Button
              size="sm"
              loading={resolve.isPending}
              onClick={() => void resolve.mutate({ id: conflict.id, resolution: 'kept_local' })}
            >
              Keep mine
            </Button>
            <Button
              size="sm"
              loading={resolve.isPending}
              onClick={() => void resolve.mutate({ id: conflict.id, resolution: 'kept_gitlab' })}
            >
              Keep GitLab
            </Button>
            <Button
              size="sm"
              loading={resolve.isPending}
              onClick={async () => {
                const ok = await confirm({
                  title: 'Merge conflict',
                  message: `Keep the tracker value for “${conflict.field}”? A merge resolves this conflict using the local value and records that choice.`,
                  confirmLabel: 'Merge',
                });
                if (!ok) return;
                void resolve.mutate({ id: conflict.id, resolution: 'merged' });
              }}
            >
              Merge
            </Button>
          </span>
        ) : (
          <Badge tone="success">{conflict.resolution ?? 'resolved'}</Badge>
        ),
    },
  ];

  return (
    <div className="stack">
      <form
        className="card card-pad stack"
        onSubmit={(event) => {
          event.preventDefault();
          setFieldErrors({});
          if (connection === null && form.accessToken.trim() === '') {
            setFieldErrors({ accessToken: 'An access token is required to create a connection.' });
            return;
          }
          void save.mutate(form);
        }}
        noValidate
      >
        <div className="row-between">
          <h2>GitLab connection</h2>
          {connection === null ? (
            <Badge>not connected</Badge>
          ) : (
            <span className="row" style={{ gap: 6 }}>
              <Badge tone={STATUS_TONE[connection.lastSyncStatus] ?? 'neutral'}>
                {connection.lastSyncStatus}
              </Badge>
              <span className="subtle">
                {connection.lastSyncAt === null ? 'never synced' : formatRelative(connection.lastSyncAt)}
              </span>
            </span>
          )}
        </div>

        {connection !== null && connection.lastSyncError !== null ? (
          <p className="field-error" role="alert">
            Last sync failed: {connection.lastSyncError}
          </p>
        ) : null}

        <fieldset className="stack-sm" style={{ border: 0, padding: 0, margin: 0 }}>
          <legend className="field-label">Where this project is stored</legend>
          <div className="stack-sm" role="radiogroup" aria-label="Where this project is stored">
            {SOURCE_OF_TRUTH.map((option) => (
              <label key={option.value} className="radio-card">
                <input
                  type="radio"
                  name="source-of-truth"
                  value={option.value}
                  checked={sourceOfTruth === option.value}
                  disabled={projectQuery.isLoading || saveSourceOfTruth.isPending}
                  onChange={() => saveSourceOfTruth.mutate(option.value)}
                />
                <span>
                  <span style={{ fontWeight: 600 }}>{option.label}</span>
                  <span className="subtle" style={{ display: 'block' }}>
                    {option.description}
                  </span>
                </span>
              </label>
            ))}
          </div>
          <p className="subtle">
            This is the project setting. The sync mode below is per connection and decides who
            wins when both sides changed the same issue.
          </p>
        </fieldset>

        <fieldset className="stack-sm" style={{ border: 0, padding: 0, margin: 0 }}>
          <legend className="field-label">Sync mode</legend>
          <div className="stack-sm" role="radiogroup" aria-label="Sync mode">
            {SYNC_MODES.map((mode) => (
              <label key={mode} className="radio-card">
                <input
                  type="radio"
                  name="sync-mode"
                  value={mode}
                  checked={form.syncMode === mode}
                  onChange={() => setForm({ ...form, syncMode: mode })}
                />
                <span>
                  <span style={{ fontWeight: 600 }}>{SYNC_MODE_LABEL[mode]}</span>
                  <span className="subtle" style={{ display: 'block' }}>
                    {SYNC_MODE_DESCRIPTION[mode]}
                  </span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>

        <div className="row" style={{ gap: 'var(--space-3)', alignItems: 'flex-start' }}>
          <Field label="GitLab base URL" htmlFor="gl-base" error={fieldErrors.baseUrl}>
            <input
              id="gl-base"
              className="input"
              value={form.baseUrl}
              placeholder="https://gitlab.example.com"
              aria-invalid={fieldErrors.baseUrl !== undefined}
              onChange={(event) => setForm({ ...form, baseUrl: event.target.value })}
            />
          </Field>
          <Field
            label="Project path"
            htmlFor="gl-path"
            error={fieldErrors.gitlabProjectPath}
            hint="e.g. group/subgroup/project"
          >
            <input
              id="gl-path"
              className="input"
              value={form.gitlabProjectPath}
              aria-invalid={fieldErrors.gitlabProjectPath !== undefined}
              onChange={(event) => setForm({ ...form, gitlabProjectPath: event.target.value })}
            />
          </Field>
        </div>

        <Field
          label="Access token"
          htmlFor="gl-token"
          error={fieldErrors.accessToken}
          hint={
            connection !== null && connection.hasToken
              ? `Stored token: ${connection.tokenHint ?? 'configured'}. Leave blank to keep it.`
              : 'A personal or project access token with api scope. Stored encrypted; never shown again.'
          }
        >
          <input
            id="gl-token"
            className="input"
            type="password"
            autoComplete="off"
            value={form.accessToken}
            aria-invalid={fieldErrors.accessToken !== undefined}
            onChange={(event) => setForm({ ...form, accessToken: event.target.value })}
          />
        </Field>

        <fieldset className="stack-sm" style={{ border: 0, padding: 0, margin: 0 }}>
          <legend className="field-label">What to sync</legend>
          <div className="row" style={{ gap: 'var(--space-4)' }}>
            <label className="checkbox">
              <input
                type="checkbox"
                checked={form.enabled}
                onChange={(event) => setForm({ ...form, enabled: event.target.checked })}
              />
              Connection enabled
            </label>
            <label className="checkbox">
              <input
                type="checkbox"
                checked={form.syncHierarchy}
                onChange={(event) => setForm({ ...form, syncHierarchy: event.target.checked })}
              />
              Parent / child
            </label>
            <label className="checkbox">
              <input
                type="checkbox"
                checked={form.syncComments}
                onChange={(event) => setForm({ ...form, syncComments: event.target.checked })}
              />
              Comments
            </label>
            <label className="checkbox">
              <input
                type="checkbox"
                checked={form.syncLabels}
                onChange={(event) => setForm({ ...form, syncLabels: event.target.checked })}
              />
              Labels
            </label>
            <label className="checkbox">
              <input
                type="checkbox"
                checked={form.syncIncidents}
                onChange={(event) => setForm({ ...form, syncIncidents: event.target.checked })}
              />
              Incidents
            </label>
          </div>
        </fieldset>

        <Field label="Title prefix" htmlFor="gl-prefix" error={fieldErrors.titlePrefix} hint="Applied to mirrored GitLab issue titles.">
          <input
            id="gl-prefix"
            className="input"
            value={form.titlePrefix}
            maxLength={32}
            onChange={(event) => setForm({ ...form, titlePrefix: event.target.value })}
          />
        </Field>

        <div className="row">
          <Button type="submit" variant="primary" loading={save.isPending}>
            {connection === null ? 'Connect GitLab' : 'Save connection'}
          </Button>
          {connection !== null ? (
            <>
              <Button
                onClick={() => void sync.mutate('full')}
                loading={sync.isPending}
                disabled={connection.lastSyncStatus === 'running'}
              >
                Sync now
              </Button>
              <Select
                label="Direction"
                hideLabel
                value="full"
                options={[
                  { value: 'full' as const, label: 'Full sync' },
                  { value: 'push' as const, label: 'Push only' },
                  { value: 'pull' as const, label: 'Pull only' },
                ]}
                onChange={(direction) => void sync.mutate(direction)}
              />
              <Button
                variant="ghost"
                onClick={async () => {
                  const ok = await confirm({
                    title: 'Disconnect GitLab',
                    message: 'Remove this connection? Mirrored links and sync history are deleted.',
                    confirmLabel: 'Disconnect',
                    destructive: true,
                  });
                  if (!ok) return;
                  try {
                    await gitlabApi.remove(projectId);
                    toast.success('GitLab disconnected');
                    connectionQuery.refetch();
                  } catch (error) {
                    toast.apiError(error);
                  }
                }}
              >
                Disconnect
              </Button>
            </>
          ) : null}
        </div>
      </form>

      <section className="card card-pad stack" aria-label="Sync history">
        <h2>Sync runs</h2>
        {runsQuery.error !== null ? (
          <ErrorState error={runsQuery.error} onRetry={runsQuery.refetch} />
        ) : runsQuery.isLoading ? (
          <SkeletonRows rows={4} height="36px" />
        ) : (runsQuery.data?.length ?? 0) === 0 ? (
          <EmptyState icon="🔄" title="No sync runs yet" description="Trigger a sync to see its history here." />
        ) : (
          <DataTable
            caption="GitLab sync run history"
            columns={runColumns}
            rows={runsQuery.data ?? []}
            rowKey={(run) => run.id}
            emptyMessage="No sync runs"
          />
        )}
      </section>

      <section className="card card-pad stack" aria-label="Conflicts">
        <div className="row-between">
          <h2>Conflicts</h2>
          <Badge tone={openConflicts.length > 0 ? 'danger' : 'success'}>
            {openConflicts.length} unresolved
          </Badge>
        </div>
        <p className="subtle">
          With a two-way sync, an issue edited on both sides since the last sync is recorded here instead
          of being silently overwritten.
        </p>
        {conflictsQuery.error !== null ? (
          <ErrorState error={conflictsQuery.error} onRetry={conflictsQuery.refetch} />
        ) : conflictsQuery.isLoading ? (
          <SkeletonRows rows={3} height="44px" />
        ) : (conflictsQuery.data?.length ?? 0) === 0 ? (
          <EmptyState icon="✅" title="No conflicts" description="Local and GitLab agree on every synced issue." />
        ) : (
          <DataTable
            caption="GitLab sync conflicts"
            columns={conflictColumns}
            rows={conflictsQuery.data ?? []}
            rowKey={(conflict) => conflict.id}
            emptyMessage="No conflicts"
          />
        )}
      </section>

      {dialog}
    </div>
  );
}
