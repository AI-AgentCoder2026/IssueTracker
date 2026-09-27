/** Settings shell: tab navigation plus the project-general and labels panels. */

import { useState } from 'react';
import { NavLink, Outlet, useParams } from 'react-router-dom';
import { useMutation, useQuery } from '../api/hooks';
import { ApiError } from '../api/client';
import { projectApi } from '../api/repo';
import {
  ISSUE_PRIORITIES,
  ISSUE_TYPES,
  ISSUE_TYPE_LABEL,
  PRIORITY_LABEL,
  asProjectId,
  type Label,
  type Project,
  type ProjectVisibility,
} from '../api/types';
import { useProjects } from '../projects/ProjectContext';
import { Button } from '../components/Button';
import { EmptyState, ErrorState } from '../components/EmptyState';
import { useConfirm } from '../components/Modal';
import { Field, Select } from '../components/Select';
import { Skeleton } from '../components/Skeleton';
import { useToast } from '../components/Toast';

const VISIBILITIES: ReadonlyArray<{ value: ProjectVisibility; label: string }> = [
  { value: 'private', label: 'Private — members only' },
  { value: 'internal', label: 'Internal — anyone signed in' },
  { value: 'public', label: 'Public — also guests' },
];

const TABS = [
  { to: '', label: 'General', end: true },
  { to: 'members', label: 'Members' },
  { to: 'workflow', label: 'Workflow' },
  { to: 'labels', label: 'Labels' },
  { to: 'gitlab', label: 'GitLab' },
  { to: 'guests', label: 'Guest access' },
];

/** Renders the settings tab bar and the panel for the active route. */
export function Settings(): JSX.Element {
  const params = useParams();
  const base = `/p/${params.projectId ?? ''}/settings`;
  return (
    <div className="settings-layout">
      <div className="page-header" style={{ marginBottom: 0 }}>
        <div className="page-title-group">
          <h1>Settings</h1>
          <p className="page-subtitle">Project configuration, access and integrations.</p>
        </div>
      </div>
      <nav className="settings-nav" aria-label="Settings sections">
        {TABS.map((tab) => (
          <NavLink
            key={tab.label}
            to={tab.to === '' ? base : `${base}/${tab.to}`}
            end={tab.end}
            className={({ isActive }) => (isActive ? 'nav-link is-active' : 'nav-link')}
          >
            {tab.label}
          </NavLink>
        ))}
      </nav>
      <Outlet />
    </div>
  );
}

/** General panel: name, description, defaults, visibility and source of truth. */
export function SettingsGeneral(): JSX.Element {
  const params = useParams();
  const projectId = asProjectId(Number(params.projectId));
  const { refetch } = useProjects();
  const toast = useToast();
  const projectQuery = useQuery<Project>((signal) => projectApi.get(projectId, signal), [projectId]);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const save = useMutation<Record<string, unknown>, unknown>(
    (patch) => projectApi.update(projectId, patch),
    {
      onSuccess: () => {
        setFieldErrors({});
        toast.success('Project saved');
        refetch();
        projectQuery.refetch();
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

  if (projectQuery.error !== null) {
    return <ErrorState error={projectQuery.error} onRetry={projectQuery.refetch} />;
  }

  const project = projectQuery.data;
  if (project === null) return <Skeleton height="220px" />;

  return (
    <form
      className="card card-pad stack"
      onSubmit={(event) => {
        event.preventDefault();
        void save.mutate({
          name: project.name,
          description: project.description,
          visibility: project.visibility,
          defaultIssueType: project.defaultIssueType,
          defaultPriority: project.defaultPriority,
        });
      }}
      noValidate
    >
      <h2>General</h2>
      <div className="row" style={{ gap: 'var(--space-3)', alignItems: 'flex-start' }}>
        <Field label="Key" htmlFor="settings-key" hint="Issue keys are immutable.">
          <input id="settings-key" className="input" value={project.key} readOnly />
        </Field>
        <div className="grow">
          <Field label="Name" htmlFor="settings-name" error={fieldErrors.name}>
            <input
              id="settings-name"
              className="input"
              defaultValue={project.name}
              key={`${project.id}-name`}
              onBlur={(event) =>
                event.target.value !== project.name &&
                void save.mutate({ name: event.target.value })
              }
            />
          </Field>
        </div>
      </div>
      <Field label="Description" htmlFor="settings-description" error={fieldErrors.description}>
        <textarea
          id="settings-description"
          className="textarea"
          style={{ fontFamily: 'var(--font-sans)' }}
          defaultValue={project.description}
          key={`${project.id}-desc`}
          rows={3}
          onBlur={(event) =>
            event.target.value !== project.description &&
            void save.mutate({ description: event.target.value })
          }
        />
      </Field>
      <div className="row" style={{ gap: 'var(--space-3)', alignItems: 'flex-start' }}>
        <Select
          label="Visibility"
          value={project.visibility}
          options={VISIBILITIES}
          onChange={(value) => void save.mutate({ visibility: value })}
        />
        <Select
          label="Default type"
          value={project.defaultIssueType}
          options={ISSUE_TYPES.map((type) => ({ value: type, label: ISSUE_TYPE_LABEL[type] }))}
          onChange={(value) => void save.mutate({ defaultIssueType: value })}
        />
        <Select
          label="Default priority"
          value={project.defaultPriority}
          options={ISSUE_PRIORITIES.map((priority) => ({
            value: priority,
            label: PRIORITY_LABEL[priority],
          }))}
          onChange={(value) => void save.mutate({ defaultPriority: value })}
        />
      </div>
      <dl className="definition-list">
        <dt>Source of truth</dt>
        <dd>{project.sourceOfTruth === 'gitlab' ? 'GitLab' : 'This tracker'}</dd>
        <dt>Next issue number</dt>
        <dd>{project.nextIssueNumber}</dd>
        <dt>Created</dt>
        <dd>{new Date(project.createdAt).toLocaleString()}</dd>
      </dl>
      <div className="row">
        <Button type="submit" variant="primary" loading={save.isPending}>
          Save changes
        </Button>
      </div>
    </form>
  );
}

const DEFAULT_LABEL_COLORS = ['#3b82f6', '#ef4444', '#10b981', '#f59e0b', '#8b5cf6', '#64748b'];

/** Label management: create, rename, recolour and delete. */
export function SettingsLabels(): JSX.Element {
  const params = useParams();
  const projectId = asProjectId(Number(params.projectId));
  const toast = useToast();
  const { confirm, dialog } = useConfirm();
  const labelsQuery = useQuery<Label[]>((signal) => projectApi.labels(projectId, signal), [projectId]);
  const [name, setName] = useState('');
  const [color, setColor] = useState(DEFAULT_LABEL_COLORS[0] ?? '#3b82f6');
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const create = useMutation<{ name: string; color: string; description: string }, unknown>(
    (input) => projectApi.createLabel(projectId, input),
    {
      onSuccess: () => {
        setName('');
        toast.success('Label created');
        labelsQuery.refetch();
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

  const labels = labelsQuery.data ?? [];

  return (
    <section className="card card-pad stack" aria-label="Labels">
      <h2>Labels</h2>
      <form
        className="row"
        style={{ alignItems: 'flex-end', gap: 'var(--space-3)' }}
        onSubmit={(event) => {
          event.preventDefault();
          setFieldErrors({});
          if (name.trim() === '') {
            setFieldErrors({ name: 'A label name is required.' });
            return;
          }
          void create.mutate({ name: name.trim(), color, description: '' });
        }}
        noValidate
      >
        <Field label="Name" htmlFor="label-name" error={fieldErrors.name}>
          <input
            id="label-name"
            className="input"
            value={name}
            maxLength={60}
            onChange={(event) => setName(event.target.value)}
          />
        </Field>
        <Field label="Colour" htmlFor="label-color" error={fieldErrors.color}>
          <input
            id="label-color"
            className="input"
            type="color"
            value={color}
            style={{ width: 60, padding: 2 }}
            onChange={(event) => setColor(event.target.value)}
          />
        </Field>
        <Button type="submit" variant="primary" loading={create.isPending}>
          Add label
        </Button>
      </form>

      {labelsQuery.error !== null ? (
        <ErrorState error={labelsQuery.error} onRetry={labelsQuery.refetch} />
      ) : labelsQuery.isLoading ? (
        <Skeleton height="60px" />
      ) : labels.length === 0 ? (
        <EmptyState icon="🏷" title="No labels yet" description="Labels group related issues for filtering." />
      ) : (
        <div className="link-list">
          {labels.map((label) => (
            <div key={label.id} className="link-row">
              <span className="row grow" style={{ gap: 8 }}>
                <span
                  aria-hidden="true"
                  style={{
                    width: 14,
                    height: 14,
                    borderRadius: 4,
                    background: label.color,
                    display: 'inline-block',
                  }}
                />
                <strong>{label.name}</strong>
                <span className="subtle mono">{label.slug}</span>
                {label.description === '' ? null : <span className="subtle">{label.description}</span>}
              </span>
              <span className="row" style={{ gap: 4 }}>
                <Button
                  size="sm"
                  onClick={() => {
                    void projectApi
                      .updateLabel(projectId, label.id, { color })
                      .then(() => {
                        toast.success('Label recoloured');
                        labelsQuery.refetch();
                      })
                      .catch((error: unknown) => toast.apiError(error));
                  }}
                >
                  Recolour
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={async () => {
                    const ok = await confirm({
                      title: 'Delete label',
                      message: `Delete “${label.name}”? It will be removed from every issue.`,
                      confirmLabel: 'Delete',
                      destructive: true,
                    });
                    if (!ok) return;
                    try {
                      await projectApi.removeLabel(projectId, label.id);
                      toast.success('Label deleted');
                      labelsQuery.refetch();
                    } catch (error) {
                      toast.apiError(error);
                    }
                  }}
                >
                  Delete
                </Button>
              </span>
            </div>
          ))}
        </div>
      )}
      {dialog}
    </section>
  );
}
