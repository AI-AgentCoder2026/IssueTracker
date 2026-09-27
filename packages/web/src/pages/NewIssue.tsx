/** Create-issue form. Validates locally, then surfaces server field errors. */

import { useState, type FormEvent } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ApiError } from '../api/client';
import { useMutation, useQuery } from '../api/hooks';
import { issueApi, projectApi, workflowApi, type CreateIssueBody } from '../api/repo';
import {
  ISSUE_PRIORITIES,
  ISSUE_TYPES,
  ISSUE_TYPE_LABEL,
  PRIORITY_LABEL,
  asProjectId,
  type Issue,
  type IssuePriority,
  type IssueType,
  type Label,
  type MemberView,
} from '../api/types';
import { RichTextEditor } from '../components/RichTextEditor';
import { Button } from '../components/Button';
import { ErrorState } from '../components/EmptyState';
import { Field, Select } from '../components/Select';
import { Skeleton } from '../components/Skeleton';
import { useToast } from '../components/Toast';

export function NewIssue(): JSX.Element {
  const params = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const projectId = asProjectId(Number(params.projectId));

  const workflowQuery = useQuery((signal) => workflowApi.get(projectId, signal), [projectId]);
  const membersQuery = useQuery<MemberView[]>((signal) => projectApi.members(projectId, signal), [projectId]);
  const labelsQuery = useQuery<Label[]>((signal) => projectApi.labels(projectId, signal), [projectId]);

  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [type, setType] = useState<IssueType>('task');
  const [priority, setPriority] = useState<IssuePriority>('medium');
  const [statusId, setStatusId] = useState<number | ''>('');
  const [assigneeId, setAssigneeId] = useState<number | ''>('');
  const [dueDate, setDueDate] = useState('');
  const [estimateHours, setEstimateHours] = useState('');
  const [labelIds, setLabelIds] = useState<number[]>([]);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const create = useMutation<CreateIssueBody, Issue>((body) => issueApi.create(body), {
    onSuccess: (issue) => {
      toast.success(`${issue.key} created`);
      void navigate(`/p/${projectId}/issues/${issue.id}`);
    },
    onError: (error) => {
      if (error instanceof ApiError) {
        const next: Record<string, string> = {};
        for (const field of error.fields) next[field.path] = field.message;
        setFieldErrors(next);
      }
      toast.apiError(error);
    },
  });

  if (workflowQuery.error !== null) {
    return <ErrorState error={workflowQuery.error} title="Could not load the workflow" onRetry={workflowQuery.refetch} />;
  }

  const statuses = workflowQuery.data?.statuses ?? [];
  const members = membersQuery.data ?? [];
  const labels = labelsQuery.data ?? [];

  const onSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    setFieldErrors({});
    if (title.trim() === '') {
      setFieldErrors({ title: 'A title is required.' });
      return;
    }
    const body: CreateIssueBody = {
      title: title.trim(),
      description,
      type,
      priority,
      ...(statusId === '' ? {} : { statusId }),
      ...(assigneeId === '' ? {} : { assigneeId }),
      ...(dueDate === '' ? {} : { dueDate: new Date(`${dueDate}T12:00:00Z`).toISOString() }),
      ...(estimateHours === '' ? {} : { estimateHours: Number(estimateHours) }),
      ...(labelIds.length === 0 ? {} : { labelIds }),
    };
    void create.mutate(body);
  };

  return (
    <div className="stack" style={{ maxWidth: 860 }}>
      <div className="page-header">
        <div className="page-title-group">
          <h1>New issue</h1>
          <p className="page-subtitle">Report something that needs doing.</p>
        </div>
        <Button onClick={() => void navigate(`/p/${projectId}/issues`)}>Cancel</Button>
      </div>

      <form className="card card-pad stack" onSubmit={onSubmit} noValidate>
        <Field label="Title" htmlFor="new-title" error={fieldErrors.title}>
          <input
            id="new-title"
            className="input"
            value={title}
            required
            maxLength={500}
            aria-invalid={fieldErrors.title !== undefined}
            onChange={(event) => setTitle(event.target.value)}
          />
        </Field>

        <RichTextEditor
          label="Description (Markdown)"
          value={description}
          onChange={setDescription}
          error={fieldErrors.description}
          rows={8}
        />

        <div className="row" style={{ gap: 'var(--space-3)', alignItems: 'flex-start' }}>
          {workflowQuery.isLoading ? (
            <Skeleton height="54px" width="100%" />
          ) : (
            <Select
              label="Status"
              value={statusId === '' ? '' : statusId}
              options={statuses.map((status) => ({ value: status.id as number, label: status.name }))}
              placeholder="Default status"
              onChange={setStatusId}
              error={fieldErrors.statusId}
            />
          )}
          <Select
            label="Type"
            value={type}
            options={ISSUE_TYPES.map((option) => ({ value: option, label: ISSUE_TYPE_LABEL[option] }))}
            onChange={setType}
            error={fieldErrors.type}
          />
          <Select
            label="Priority"
            value={priority}
            options={ISSUE_PRIORITIES.map((option) => ({
              value: option,
              label: PRIORITY_LABEL[option],
            }))}
            onChange={setPriority}
            error={fieldErrors.priority}
          />
        </div>

        <div className="row" style={{ gap: 'var(--space-3)', alignItems: 'flex-start' }}>
          <Select
            label="Assignee"
            value={assigneeId}
            options={members.map((member) => ({
              value: member.userId as number,
              label: member.user.displayName,
            }))}
            placeholder="Unassigned"
            onChange={setAssigneeId}
            error={fieldErrors.assigneeId}
          />
          <Field label="Due date" htmlFor="new-due" error={fieldErrors.dueDate}>
            <input
              id="new-due"
              className="input"
              type="date"
              value={dueDate}
              onChange={(event) => setDueDate(event.target.value)}
            />
          </Field>
          <Field label="Estimate (hours)" htmlFor="new-estimate" error={fieldErrors.estimateHours}>
            <input
              id="new-estimate"
              className="input"
              type="number"
              min={0}
              step={0.5}
              value={estimateHours}
              onChange={(event) => setEstimateHours(event.target.value)}
            />
          </Field>
        </div>

        {labels.length > 0 ? (
          <Field label="Labels" htmlFor="new-labels">
            <div className="row" id="new-labels" style={{ gap: 6 }}>
              {labels.map((label) => {
                const active = labelIds.includes(label.id);
                return (
                  <Button
                    key={label.id}
                    size="sm"
                    type="button"
                    variant={active ? 'primary' : 'default'}
                    aria-pressed={active}
                    onClick={() =>
                      setLabelIds(
                        active ? labelIds.filter((id) => id !== label.id) : [...labelIds, label.id],
                      )
                    }
                  >
                    {label.name}
                  </Button>
                );
              })}
            </div>
          </Field>
        ) : null}

        <div className="row">
          <Button type="submit" variant="primary" loading={create.isPending}>
            Create issue
          </Button>
          <Button type="button" onClick={() => void navigate(`/p/${projectId}/issues`)} disabled={create.isPending}>
            Cancel
          </Button>
        </div>
      </form>
    </div>
  );
}
