/**
 * Issue detail: editable title/description, workflow transitions, parent/child
 * tree, dependency links, comments with mentions, attachments and the timeline.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ApiError } from '../api/client';
import { useMutation, useQuery } from '../api/hooks';
import { DevelopmentPanel } from '../components/DevelopmentPanel';
import { issueApi, projectApi, vcsApi, workflowApi } from '../api/repo';
import {
  DEPENDENCY_KINDS,
  ISSUE_PRIORITIES,
  ISSUE_TYPES,
  ISSUE_TYPE_LABEL,
  PRIORITY_LABEL,
  asIssueId,
  asProjectId,
  type CommentWithAuthor,
  type DependencyKind,
  type Issue,
  type IssueAttachment,
  type IssueId,
  type IssueLink,
  type IssueSummary,
  type IssueTimeline,
  type MemberView,
  type TransitionCheck,
} from '../api/types';
import { formatDate, formatDateTime, formatHours, formatRelative } from '../lib/format';
import { useAuth } from '../auth/AuthContext';
import { isPresenceStale, useRealtime, useRealtimeEvent } from '../realtime/useRealtime';
import { AttachmentList } from '../components/AttachmentList';
import { Avatar } from '../components/Avatar';
import { Badge } from '../components/Badge';
import { Button } from '../components/Button';
import { EmptyState, ErrorState } from '../components/EmptyState';
import { MentionInput } from '../components/MentionInput';
import { useConfirm } from '../components/Modal';
import { RichTextEditor } from '../components/RichTextEditor';
import { Field, Select } from '../components/Select';
import { Skeleton, SkeletonRows } from '../components/Skeleton';
import { Timeline, TimingStrip } from '../components/Timeline';
import { useToast } from '../components/Toast';

export function IssueDetail(): JSX.Element {
  const params = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const { confirm, dialog } = useConfirm();
  const { user } = useAuth();
  const { setWatching, presenceFor } = useRealtime();

  const issueId = asIssueId(Number(params.issueId));
  const projectId = asProjectId(Number(params.projectId));

  const issueQuery = useQuery<Issue>((signal) => issueApi.get(issueId, signal), [issueId]);
  const transitionsQuery = useQuery<TransitionCheck>(
    (signal) => issueApi.availableTransitions(issueId, signal),
    [issueId, issueQuery.data?.version],
  );
  const timelineQuery = useQuery<IssueTimeline>((signal) => issueApi.timeline(issueId, signal), [issueId]);
  const commentsQuery = useQuery<CommentWithAuthor[]>((signal) => issueApi.comments(issueId, signal), [issueId]);
  const childrenQuery = useQuery<IssueSummary[]>((signal) => issueApi.children(issueId, signal), [issueId]);
  const ancestorsQuery = useQuery<IssueSummary[]>((signal) => issueApi.ancestors(issueId, signal), [issueId]);
  const linksQuery = useQuery<IssueLink[]>((signal) => issueApi.links(issueId, signal), [issueId]);
  const attachmentsQuery = useQuery<IssueAttachment[]>(
    (signal) => issueApi.attachments(issueId, signal),
    [issueId],
  );
  const workflowQuery = useQuery((signal) => workflowApi.get(projectId, signal), [projectId]);
// Repositories back the Development panel; a project with none simply renders
// the panel in its empty state rather than erroring.
const repositoriesQuery = useQuery((signal) => vcsApi.repositories(projectId, signal), [projectId]);
  const membersQuery = useQuery<MemberView[]>((signal) => projectApi.members(projectId, signal), [projectId]);


  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [editingDescription, setEditingDescription] = useState(false);
  const [commentBody, setCommentBody] = useState('');
  const [newLink, setNewLink] = useState<{ kind: DependencyKind; target: string }>({
    kind: 'relates_to',
    target: '',
  });
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  useEffect(() => setWatching(issueId, 'viewing issue'), [issueId, setWatching]);
  useEffect(() => () => setWatching(null), [setWatching]);

  useEffect(() => {
    if (issueQuery.data === null) return;
    setTitle(issueQuery.data.title);
    setDescription(issueQuery.data.description);
  }, [issueQuery.data]);

  useRealtimeEvent('issue.updated', (message) => {
    if (message.issueId !== undefined && message.issueId !== issueId) return;
    issueQuery.refetch();
  });
  useRealtimeEvent('comment.created', (message) => {
    if (message.issueId !== undefined && message.issueId !== issueId) return;
    commentsQuery.refetch();
  });

  const presence = useMemo(
    () =>
      presenceFor(issueId)
        .filter((entry) => entry.userId !== user?.id)
        .filter((entry) => !isPresenceStale(entry)),
    [presenceFor, issueId, user?.id],
  );

  const { refetch: refetchIssue } = issueQuery;
  const { refetch: refetchTimeline } = timelineQuery;
  const { refetch: refetchTransitions } = transitionsQuery;

  const refreshAll = useCallback(() => {
    refetchIssue();
    refetchTimeline();
    refetchTransitions();
  }, [refetchIssue, refetchTimeline, refetchTransitions]);

  const savePatch = useMutation<Record<string, unknown>, unknown>(
    (patch) => issueApi.update(issueId, patch),
    {
      onSuccess: () => {
        setFieldErrors({});
        toast.success('Issue updated');
        refreshAll();
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

  const transition = useMutation<number, unknown>(
    (toStatusId) =>
      issueApi.transition(issueId, {
        toStatusId,
        ...(issueQuery.data === null ? {} : { expectedVersion: issueQuery.data.version }),
      }),
    {
      onSuccess: () => {
        toast.success('Status changed');
        refreshAll();
      },
      onError: (error) => {
        // `workflow_violation` (422) carries the reason; show it verbatim.
        toast.apiError(error);
      },
    },
  );

  const postComment = useMutation<string, unknown>(
    (body) => issueApi.createComment(issueId, { body }),
    {
      onSuccess: () => {
        setCommentBody('');
        commentsQuery.refetch();
        timelineQuery.refetch();
        issueQuery.refetch();
      },
      onError: (error) => toast.apiError(error),
    },
  );

  const addLink = useMutation<{ kind: DependencyKind; target: string }, unknown>(
    ({ kind, target }) => issueApi.createLink(issueId, { kind, targetIssueId: Number(target) }),
    {
      onSuccess: () => {
        setNewLink({ kind: 'relates_to', target: '' });
        linksQuery.refetch();
        toast.success('Link added');
      },
      onError: (error) => toast.apiError(error),
    },
  );

  if (issueQuery.error !== null) {
    return (
      <ErrorState
        error={issueQuery.error}
        title="Could not load this issue"
        onRetry={issueQuery.refetch}
      />
    );
  }

  if (issueQuery.data === null) {
    return (
      <div className="stack">
        <Skeleton height="22px" width="30%" />
        <Skeleton height="180px" />
        <SkeletonRows rows={4} />
      </div>
    );
  }

  const issue = issueQuery.data;
  const statuses = workflowQuery.data?.statuses ?? [];
  const transitions = transitionsQuery.data?.available ?? [];
  const members = membersQuery.data ?? [];
  const ancestors = ancestorsQuery.data ?? [];
  const children = childrenQuery.data ?? [];
  const comments = commentsQuery.data ?? [];
  const links = linksQuery.data ?? [];
  const attachments = attachmentsQuery.data ?? [];

  return (
    <div className="stack">
      <nav aria-label="Breadcrumb" className="subtle">
        <Link to={`/p/${projectId}/issues`}>Issues</Link>
        <span aria-hidden="true"> / </span>
        <span className="mono">{issue.key}</span>
      </nav>

      <div className="page-header">
        <div className="page-title-group grow">
          <div className="row" style={{ gap: 8 }}>
            <span className="mono subtle">{issue.key}</span>
            {issue.archived ? <Badge tone="warning">Archived</Badge> : null}
          </div>
          <h1 style={{ marginTop: 4 }}>{issue.title}</h1>
          <p className="page-subtitle">
            Reported{' '}
            {issue.reporterId === null ? 'by an unknown user' : `by user ${issue.reporterId}`} on{' '}
            {formatDateTime(issue.createdAt)} Â· updated {formatRelative(issue.updatedAt)} Â· v{issue.version}
          </p>
        </div>
        <div className="toolbar">
          {presence.length > 0 ? (
            <span className="row" style={{ gap: 6 }} title="Also viewing this issue">
              {presence.map((entry) => (
                <Avatar key={entry.userId} name={entry.displayName} src={entry.avatarUrl} size="sm" online />
              ))}
              <span className="subtle nowrap">
                {presence.length === 1 ? '1 other viewing' : `${presence.length} others viewing`}
              </span>
            </span>
          ) : null}
          <Button
            onClick={async () => {
              const ok = await confirm({
                title: 'Delete issue',
                message: `Permanently delete ${issue.key}? This cannot be undone.`,
                confirmLabel: 'Delete',
                destructive: true,
              });
              if (!ok) return;
              try {
                await issueApi.remove(issueId);
                toast.success('Issue deleted');
                void navigate(`/p/${projectId}/issues`);
              } catch (error) {
                toast.apiError(error);
              }
            }}
            variant="ghost"
          >
            Delete
          </Button>
        </div>
      </div>

      <TimingStrip timeline={timelineQuery.data} />

      <div className="issue-layout">
        <div className="stack">
          <section className="card card-pad stack-sm" aria-label="Description">
            <div className="row-between">
              <h2>Description</h2>
              {!editingDescription ? (
                <Button size="sm" onClick={() => setEditingDescription(true)}>
                  Edit
                </Button>
              ) : null}
            </div>
            {editingDescription ? (
              <RichTextEditor
                label="Description (Markdown)"
                value={description}
                onChange={setDescription}
                busy={savePatch.isPending}
                error={fieldErrors.description}
                onSave={() => {
                  void savePatch.mutate({ description, expectedVersion: issue.version });
                  setEditingDescription(false);
                }}
                onCancel={() => {
                  setDescription(issue.description);
                  setEditingDescription(false);
                }}
              />
            ) : (
              <div>
                {issue.description.trim() === '' ? (
                  <p className="subtle">No description yet.</p>
                ) : (
                  <pre style={{ margin: 0, whiteSpace: 'pre-wrap', fontFamily: 'var(--font-sans)' }}>
                    {issue.description}
                  </pre>
                )}
              </div>
            )}
          </section>

          <section className="card card-pad stack" aria-label="Comments">
            <h2>Comments ({comments.length})</h2>
            {commentsQuery.isLoading ? (
              <SkeletonRows rows={3} height="52px" />
            ) : comments.length === 0 ? (
              <EmptyState icon="ðŸ’¬" title="No comments yet" description="Start the discussion below." />
            ) : (
              <div>
                {comments.map((comment) => (
                  <CommentRow
                    key={comment.id}
                    comment={comment}
                    canEdit={comment.authorId === user?.id}
                    onEdit={async (body) => {
                      try {
                        await issueApi.updateComment(comment.id, { body });
                        commentsQuery.refetch();
                        toast.success('Comment updated');
                      } catch (error) {
                        toast.apiError(error);
                      }
                    }}
                    onDelete={async () => {
                      const ok = await confirm({
                        title: 'Delete comment',
                        message: 'This comment will be removed permanently.',
                        confirmLabel: 'Delete',
                        destructive: true,
                      });
                      if (!ok) return;
                      try {
                        await issueApi.removeComment(comment.id);
                        commentsQuery.refetch();
                      } catch (error) {
                        toast.apiError(error);
                      }
                    }}
                  />
                ))}
              </div>
            )}
            <MentionInput
              label="Add a comment"
              placeholder="Share an updateâ€¦ use @ to mention a teammate"
              value={commentBody}
              onChange={setCommentBody}
              busy={postComment.isPending}
              onSubmit={() => {
                if (commentBody.trim() === '') return;
                void postComment.mutate(commentBody.trim());
              }}
              error={fieldErrors.body}
            />
          </section>

          <DevelopmentPanel
            issueId={issueId}
            projectId={projectId}
            repositories={repositoriesQuery.data?.repositories ?? []}
            onError={(message) => toast.error(message)}
          />

          <section className="card card-pad stack" aria-label="Timeline">
            <h2>Timeline</h2>
            <Timeline timeline={timelineQuery.data} isLoading={timelineQuery.isLoading} />
          </section>
        </div>

        <aside className="issue-side" aria-label="Issue properties">
          <section className="card card-pad stack-sm">
            <h3>Status</h3>
            {transitionsQuery.isLoading ? (
              <Skeleton height="32px" />
            ) : transitions.length === 0 ? (
              <p className="subtle">
                {transitionsQuery.data?.reason ?? 'No transitions are available from this status.'}
              </p>
            ) : (
              <div className="row" style={{ gap: 6 }}>
                {transitions.map((option) => {
                  const target = statuses.find((status) => status.id === option.toStatusId);
                  return (
                    <Button
                      key={option.id}
                      size="sm"
                      variant="primary"
                      loading={transition.isPending}
                      title={option.description === '' ? undefined : option.description}
                      onClick={() => void transition.mutate(option.toStatusId as number)}
                    >
                      {option.name === '' ? (target?.name ?? 'Move') : option.name}
                    </Button>
                  );
                })}
              </div>
            )}
            {transitionsQuery.data !== null && !transitionsQuery.data.allowed && transitionsQuery.data.reason !== '' ? (
              <p className="field-error">{transitionsQuery.data.reason}</p>
            ) : null}
          </section>

          <section className="card card-pad stack-sm">
            <h3>Details</h3>
            <Field label="Title" htmlFor="issue-title" error={fieldErrors.title}>
              <input
                id="issue-title"
                className="input"
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                onBlur={() => {
                  if (title !== issue.title && title.trim() !== '') {
                    void savePatch.mutate({ title: title.trim(), expectedVersion: issue.version });
                  }
                }}
              />
            </Field>
            <Select
              label="Type"
              value={issue.type}
              options={ISSUE_TYPES.map((type) => ({ value: type, label: ISSUE_TYPE_LABEL[type] }))}
              onChange={(value) => void savePatch.mutate({ type: value, expectedVersion: issue.version })}
            />
            <Select
              label="Priority"
              value={issue.priority}
              options={ISSUE_PRIORITIES.map((priority) => ({
                value: priority,
                label: PRIORITY_LABEL[priority],
              }))}
              onChange={(value) => void savePatch.mutate({ priority: value, expectedVersion: issue.version })}
            />
            <Select
              label="Assignee"
              value={issue.assigneeId ?? 0}
              placeholder="Unassigned"
              options={members.map((member) => ({
                value: member.userId as number,
                label: member.user.displayName,
              }))}
              onChange={(value) =>
                void savePatch.mutate({
                  assigneeId: value === 0 ? null : value,
                  expectedVersion: issue.version,
                })
              }
            />
            <Field
              label="Due date"
              htmlFor="issue-due"
              error={fieldErrors.dueDate}
              hint={issue.dueDate === null ? 'No due date set' : formatDate(issue.dueDate)}
            >
              <input
                id="issue-due"
                className="input"
                type="date"
                value={issue.dueDate === null ? '' : issue.dueDate.slice(0, 10)}
                onChange={(event) =>
                  void savePatch.mutate({
                    dueDate:
                      event.target.value === ''
                        ? null
                        : new Date(`${event.target.value}T12:00:00Z`).toISOString(),
                    expectedVersion: issue.version,
                  })
                }
              />
            </Field>
            <dl className="definition-list">
              <dt>State</dt>
              <dd>
                <Badge dot>{issue.state.replace('_', ' ')}</Badge>
              </dd>
              <dt>Spent</dt>
              <dd>
                {formatHours(issue.timeSpentHours)}
                {issue.estimateHours === null ? '' : ` of ${formatHours(issue.estimateHours)}`}
              </dd>
            </dl>
          </section>

          <section className="card card-pad stack-sm">
            <h3>Hierarchy</h3>
            {ancestors.length === 0 ? (
              <p className="subtle">No parent issue.</p>
            ) : (
              <ul style={{ listStyle: 'none', margin: 0, padding: 0 }} className="stack-sm">
                {ancestors.map((ancestor) => (
                  <li key={ancestor.id}>
                    <Link to={`/p/${projectId}/issues/${ancestor.id}`}>
                      <span className="mono subtle">{ancestor.key}</span> {ancestor.title}
                    </Link>
                  </li>
                ))}
              </ul>
            )}
            {children.length === 0 ? (
              <p className="subtle">No sub-tasks.</p>
            ) : (
              <ul style={{ listStyle: 'none', margin: 0, padding: 0 }} className="stack-sm">
                {children.map((child) => (
                  <li key={child.id}>
                    <Link to={`/p/${projectId}/issues/${child.id}`}>
                      <span className="mono subtle">{child.key}</span> {child.title}
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="card card-pad stack-sm">
            <h3>Dependencies</h3>
            {links.length === 0 ? (
              <p className="subtle">No linked issues.</p>
            ) : (
              <div className="link-list">
                {links.map((link) => (
                  <div key={link.id} className="link-row">
                    <span className="truncate">
                      <Badge>{link.kind.replace(/_/g, ' ')}</Badge>{' '}
                      <Link to={`/p/${projectId}/issues/${link.targetIssueId}`}>
                        {link.targetIssueId === issueId ? `â†© #${link.sourceIssueId}` : `#${link.targetIssueId}`}
                      </Link>
                    </span>
                    <Button
                      size="sm"
                      variant="ghost"
                      aria-label={`Remove ${link.kind} link`}
                      onClick={async () => {
                        const ok = await confirm({
                          title: 'Remove link',
                          message: 'Remove this dependency link?',
                          confirmLabel: 'Remove',
                          destructive: true,
                        });
                        if (!ok) return;
                        try {
                          await issueApi.unlink(issueId, link.id);
                          linksQuery.refetch();
                        } catch (error) {
                          toast.apiError(error);
                        }
                      }}
                    >
                      âœ•
                    </Button>
                  </div>
                ))}
              </div>
            )}
            <div className="row" style={{ alignItems: 'flex-end' }}>
              <Select
                label="Kind"
                value={newLink.kind}
                options={DEPENDENCY_KINDS.map((kind) => ({ value: kind, label: kind.replace(/_/g, ' ') }))}
                onChange={(value) => setNewLink({ ...newLink, kind: value })}
              />
              <div className="grow">
                <Field label="Target issue id" htmlFor="link-target" error={fieldErrors.targetIssueId}>
                  <input
                    id="link-target"
                    className="input"
                    inputMode="numeric"
                    value={newLink.target}
                    onChange={(event) => setNewLink({ ...newLink, target: event.target.value })}
                  />
                </Field>
              </div>
            </div>
            <Button
              size="sm"
              loading={addLink.isPending}
              disabled={newLink.target.trim() === ''}
              onClick={() => void addLink.mutate(newLink)}
            >
              Add link
            </Button>
          </section>

          <section className="card card-pad stack-sm">
            <h3>Attachments</h3>
            <AttachmentList
              issueId={issueId as IssueId}
              attachments={attachments}
              isLoading={attachmentsQuery.isLoading}
              onChanged={attachmentsQuery.refetch}
            />
          </section>
        </aside>
      </div>

      {dialog}
    </div>
  );
}

function CommentRow({
  comment,
  canEdit,
  onEdit,
  onDelete,
}: {
  comment: CommentWithAuthor;
  canEdit: boolean;
  onEdit: (body: string) => Promise<void>;
  onDelete: () => Promise<void>;
}): JSX.Element {
  const [isEditing, setIsEditing] = useState(false);
  const [draft, setDraft] = useState(comment.body);

  return (
    <article className="comment">
      <Avatar name={comment.authorName} src={comment.authorAvatarUrl} />
      <div className="grow">
        <div className="comment-meta">
          <strong>{comment.authorName}</strong>
          <span className="subtle" title={comment.createdAt}>
            {formatRelative(comment.createdAt)}
          </span>
          {comment.editedAt === null ? null : <span className="subtle">(edited)</span>}
          {comment.isSystem ? <Badge>system</Badge> : null}
        </div>
        {isEditing ? (
          <div className="stack-sm" style={{ marginTop: 6 }}>
            <textarea
              className="textarea"
              style={{ fontFamily: 'var(--font-sans)' }}
              rows={3}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              aria-label="Edit comment"
            />
            <div className="row">
              <Button
                size="sm"
                variant="primary"
                onClick={() => {
                  setIsEditing(false);
                  void onEdit(draft);
                }}
              >
                Save
              </Button>
              <Button
                size="sm"
                onClick={() => {
                  setIsEditing(false);
                  setDraft(comment.body);
                }}
              >
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          <div className="comment-body">
            {comment.body.split('\n').map((line, index) => (
              <p key={index}>{renderMentionLine(line)}</p>
            ))}
            {comment.attachments.length > 0 ? (
              <div className="row" style={{ gap: 4, marginTop: 4 }}>
                {comment.attachments.map((attachment) => (
                  <Badge key={attachment.id}>ðŸ“Ž {attachment.filename}</Badge>
                ))}
              </div>
            ) : null}
          </div>
        )}
        {canEdit && !isEditing ? (
          <div className="row" style={{ gap: 4, marginTop: 4 }}>
            <Button size="sm" variant="ghost" onClick={() => setIsEditing(true)}>
              Edit
            </Button>
            <Button size="sm" variant="ghost" onClick={() => void onDelete()}>
              Delete
            </Button>
          </div>
        ) : null}
      </div>
    </article>
  );
}

/** Highlights `@username` tokens without interpreting the rest as HTML. */
function renderMentionLine(line: string): JSX.Element {
  const parts = line.split(/(@[a-zA-Z0-9][a-zA-Z0-9._-]*)/g);
  return (
    <>
      {parts.map((part, index) =>
        part.startsWith('@') ? (
          <strong key={index} style={{ color: 'var(--accent)' }}>
            {part}
          </strong>
        ) : (
          <span key={index}>{part}</span>
        ),
      )}
    </>
  );
}

