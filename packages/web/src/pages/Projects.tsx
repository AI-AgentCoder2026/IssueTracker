import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { useMutation } from '../api/hooks';
import { ApiError } from '../api/client';
import { projectApi, type CreateProjectInput } from '../api/repo';
import {
  ISSUE_PRIORITIES,
  ISSUE_TYPES,
  PRIORITY_LABEL,
  ISSUE_TYPE_LABEL,
  type Project,
  type ProjectVisibility,
} from '../api/types';
import { useProjects } from '../projects/ProjectContext';
import { Badge } from '../components/Badge';
import { Button } from '../components/Button';
import { EmptyState, ErrorState } from '../components/EmptyState';
import { Field, Select } from '../components/Select';
import { Skeleton } from '../components/Skeleton';
import { useToast } from '../components/Toast';

const VISIBILITIES: ReadonlyArray<{ value: ProjectVisibility; label: string }> = [
  { value: 'private', label: 'Private — members only' },
  { value: 'internal', label: 'Internal — anyone signed in' },
  { value: 'public', label: 'Public — also guests' },
];

const EMPTY: CreateProjectInput = {
  key: '',
  name: '',
  description: '',
  visibility: 'private',
  defaultIssueType: 'task',
  defaultPriority: 'medium',
};

/** Landing page: every project the user can reach, plus project creation. */
export function Projects(): JSX.Element {
  const { projects, isLoading, error, refetch } = useProjects();
  const toast = useToast();
  const [isCreating, setIsCreating] = useState(false);
  const [form, setForm] = useState<CreateProjectInput>(EMPTY);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const create = useMutation<CreateProjectInput, Project>(
    (input) => projectApi.create(input),
    {
      onSuccess: (project) => {
        toast.success(`Project ${project.key} created`);
        setForm(EMPTY);
        setIsCreating(false);
        refetch();
      },
      onError: (apiError) => {
        if (apiError instanceof ApiError) {
          const next: Record<string, string> = {};
          for (const field of apiError.fields) next[field.path] = field.message;
          setFieldErrors(next);
        }
        toast.apiError(apiError);
      },
    },
  );

  const onSubmit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    setFieldErrors({});
    await create.mutate(form);
  };

  return (
    <div className="stack">
      <div className="page-header">
        <div className="page-title-group">
          <h1>Projects</h1>
          <p className="page-subtitle">
            {projects.length === 0
              ? 'You are not a member of any project yet.'
              : `You have access to ${projects.length} project${projects.length === 1 ? '' : 's'}.`}
          </p>
        </div>
        <Button variant="primary" onClick={() => setIsCreating((v) => !v)}>
          {isCreating ? 'Cancel' : 'New project'}
        </Button>
      </div>

      {isCreating ? (
        <form className="card card-pad stack" onSubmit={(event) => void onSubmit(event)} noValidate>
          <h2>Create a project</h2>
          <div className="row" style={{ gap: 'var(--space-3)', alignItems: 'flex-start' }}>
            <Field label="Key" htmlFor="project-key" error={fieldErrors.key} hint="2–10 letters, used in issue keys like PROJ-1.">
              <input
                id="project-key"
                className="input"
                value={form.key}
                maxLength={10}
                required
                aria-invalid={fieldErrors.key !== undefined}
                onChange={(event) => setForm({ ...form, key: event.target.value.toUpperCase() })}
              />
            </Field>
            <div className="grow">
              <Field label="Name" htmlFor="project-name" error={fieldErrors.name}>
                <input
                  id="project-name"
                  className="input"
                  value={form.name}
                  required
                  aria-invalid={fieldErrors.name !== undefined}
                  onChange={(event) => setForm({ ...form, name: event.target.value })}
                />
              </Field>
            </div>
          </div>
          <Field label="Description" htmlFor="project-description" error={fieldErrors.description}>
            <textarea
              id="project-description"
              className="textarea"
              style={{ fontFamily: 'var(--font-sans)' }}
              rows={3}
              value={form.description}
              onChange={(event) => setForm({ ...form, description: event.target.value })}
            />
          </Field>
          <div className="row" style={{ gap: 'var(--space-3)', alignItems: 'flex-start' }}>
            <Select
              label="Visibility"
              value={form.visibility}
              options={VISIBILITIES}
              onChange={(value) => setForm({ ...form, visibility: value })}
            />
            <Select
              label="Default type"
              value={form.defaultIssueType}
              options={ISSUE_TYPES.map((type) => ({ value: type, label: ISSUE_TYPE_LABEL[type] }))}
              onChange={(value) => setForm({ ...form, defaultIssueType: value })}
            />
            <Select
              label="Default priority"
              value={form.defaultPriority}
              options={ISSUE_PRIORITIES.map((priority) => ({ value: priority, label: PRIORITY_LABEL[priority] }))}
              onChange={(value) => setForm({ ...form, defaultPriority: value })}
            />
          </div>
          <div className="row">
            <Button type="submit" variant="primary" loading={create.isPending}>
              Create project
            </Button>
          </div>
        </form>
      ) : null}

      {isLoading ? (
        <div className="project-grid">
          {[0, 1, 2].map((index) => (
            <div key={index} className="project-tile">
              <Skeleton height="18px" width="40%" />
              <Skeleton height="14px" width="80%" />
              <Skeleton height="12px" width="60%" />
            </div>
          ))}
        </div>
      ) : error !== null ? (
        <ErrorState error={error} title="Could not load your projects" onRetry={refetch} />
      ) : projects.length === 0 ? (
        <EmptyState
          icon="📁"
          title="No projects yet"
          description="Create a project to start tracking issues, or ask an administrator for an invitation."
          action={{ label: 'Create a project', onClick: () => setIsCreating(true) }}
        />
      ) : (
        <div className="project-grid">
          {projects.map((project) => (
            <Link key={project.id} className="project-tile" to={`/p/${project.id}/board`}>
              <div className="row-between">
                <span className="switcher-key">{project.key}</span>
                <Badge>{project.visibility}</Badge>
              </div>
              <strong style={{ fontSize: 15 }}>{project.name}</strong>
              <span className="subtle">
                {project.description === '' ? 'No description' : project.description}
              </span>
              <span className="subtle">
                {project.nextIssueNumber - 1} issues · default {ISSUE_TYPE_LABEL[project.defaultIssueType]}
                {project.sourceOfTruth === 'gitlab' ? ' · GitLab is source of truth' : ''}
              </span>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
