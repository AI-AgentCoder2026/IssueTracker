/**
 * Issue list: free-text search plus the full filter bar (state, type, priority,
 * assignee, labels, due-soon, overdue, unassigned) and a sortable result table.
 */

import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useDebounce, useQuery } from '../api/hooks';
import { issueApi, projectApi, type SearchFilters } from '../api/repo';
import {
  ISSUE_PRIORITIES,
  ISSUE_STATES,
  ISSUE_TYPES,
  ISSUE_TYPE_LABEL,
  PRIORITY_LABEL,
  asProjectId,
  type IssuePriority,
  type IssueState,
  type IssueSummary,
  type IssueType,
  type Label,
  type MemberView,
  type SearchResultPage,
} from '../api/types';
import { formatDate, formatRelative } from '../lib/format';
import { Avatar } from '../components/Avatar';
import { Badge } from '../components/Badge';
import { Button } from '../components/Button';
import { EmptyState, ErrorState } from '../components/EmptyState';
import { Field, Select } from '../components/Select';
import { useToast } from '../components/Toast';

const DUE_WINDOWS = [
  { value: '1d' as const, label: 'Due within 1 day' },
  { value: '3d' as const, label: 'Due within 3 days' },
  { value: '7d' as const, label: 'Due within 7 days' },
  { value: '14d' as const, label: 'Due within 14 days' },
  { value: '30d' as const, label: 'Due within 30 days' },
];

const SORTS = [
  { value: 'updated_desc' as const, label: 'Recently updated' },
  { value: 'created_desc' as const, label: 'Newest' },
  { value: 'created_asc' as const, label: 'Oldest' },
  { value: 'due_asc' as const, label: 'Due date' },
  { value: 'priority_desc' as const, label: 'Priority' },
  { value: 'key_asc' as const, label: 'Key' },
];

const EMPTY_FILTERS: SearchFilters = {
  q: '',
  states: [],
  types: [],
  priorities: [],
  assigneeIds: [],
  labelIds: [],
  overdueOnly: false,
  unassignedOnly: false,
  sort: 'updated_desc',
};

export function IssueList(): JSX.Element {
  const params = useParams();
  const projectId = asProjectId(Number(params.projectId));
  const toast = useToast();
  const navigate = useNavigate();
  const id = useId();

  const [filters, setFilters] = useState<SearchFilters>(EMPTY_FILTERS);
  const debouncedQuery = useDebounce(filters.q, 350);
  const [showFilters, setShowFilters] = useState(false);

  const labelsQuery = useQuery<Label[]>((signal) => projectApi.labels(projectId, signal), [projectId]);
  const membersQuery = useQuery<MemberView[]>(
    (signal) => projectApi.members(projectId, signal),
    [projectId],
  );

  const results = useQuery<SearchResultPage>(
    (signal) => issueApi.search(projectId, { ...filters, q: debouncedQuery }, signal),
    [
      projectId,
      debouncedQuery,
      filters.states.join(','),
      filters.types.join(','),
      filters.priorities.join(','),
      filters.assigneeIds.join(','),
      filters.labelIds.join(','),
      filters.dueWithin ?? '',
      String(filters.overdueOnly),
      String(filters.unassignedOnly),
      filters.sort,
    ],
  );

  const labelsById = useMemo(
    () => new Map((labelsQuery.data ?? []).map((label) => [label.id, label.name])),
    [labelsQuery.data],
  );

  const activeFilterCount =
    filters.states.length +
    filters.types.length +
    filters.priorities.length +
    filters.assigneeIds.length +
    filters.labelIds.length +
    (filters.dueWithin !== undefined ? 1 : 0) +
    (filters.overdueOnly ? 1 : 0) +
    (filters.unassignedOnly ? 1 : 0);

  return (
    <div className="stack">
      <div className="page-header">
        <div className="page-title-group">
          <h1>Issues</h1>
          <p className="page-subtitle">
            {results.data === null
              ? 'Search and filter everything in this project.'
              : `${results.data.total} matching issue${results.data.total === 1 ? '' : 's'}${
                  results.data.tookMs > 0 ? ` · ${results.data.tookMs}ms` : ''
                }`}
          </p>
        </div>
        <div className="toolbar">
          <Button
            onClick={() => setShowFilters((v) => !v)}
            aria-expanded={showFilters}
            aria-controls={`${id}-filters`}
          >
            Filters{activeFilterCount > 0 ? ` (${activeFilterCount})` : ''}
          </Button>
          <Button onClick={results.refetch} loading={results.isRefreshing}>
            Refresh
          </Button>
          <Link className="btn btn--primary" to={`/p/${projectId}/issues/new`}>
            New issue
          </Link>
        </div>
      </div>

      <div className="filter-bar">
        <div className="grow" style={{ minWidth: 220 }}>
          <Field label="Search" htmlFor={`${id}-q`} hint="Full-text over title, description and key.">
            <input
              id={`${id}-q`}
              className="input"
              type="search"
              value={filters.q}
              placeholder="Search issues…"
              onChange={(event) => setFilters({ ...filters, q: event.target.value })}
            />
          </Field>
        </div>
        <div className="row" style={{ gap: 'var(--space-2)' }}>
          <label className="checkbox">
            <input
              type="checkbox"
              checked={filters.unassignedOnly}
              onChange={(event) => setFilters({ ...filters, unassignedOnly: event.target.checked })}
            />
            Unassigned
          </label>
          <label className="checkbox">
            <input
              type="checkbox"
              checked={filters.overdueOnly}
              onChange={(event) => setFilters({ ...filters, overdueOnly: event.target.checked })}
            />
            Overdue
          </label>
        </div>
      </div>

      {showFilters ? (
        <div className="filter-bar" id={`${id}-filters`}>
          <MultiFilter
            label="State"
            options={ISSUE_STATES.map((state) => ({ value: state, label: state }))}
            selected={filters.states}
            onChange={(states) => setFilters({ ...filters, states: states as IssueState[] })}
          />
          <MultiFilter
            label="Type"
            options={ISSUE_TYPES.map((type) => ({ value: type, label: ISSUE_TYPE_LABEL[type] }))}
            selected={filters.types}
            onChange={(types) => setFilters({ ...filters, types: types as IssueType[] })}
          />
          <MultiFilter
            label="Priority"
            options={ISSUE_PRIORITIES.map((priority) => ({
              value: priority,
              label: PRIORITY_LABEL[priority],
            }))}
            selected={filters.priorities}
            onChange={(priorities) => setFilters({ ...filters, priorities: priorities as IssuePriority[] })}
          />
          <MultiFilter
            label="Assignee"
            options={(membersQuery.data ?? []).map((member) => ({
              value: String(member.userId),
              label: member.user.displayName,
            }))}
            selected={filters.assigneeIds.map(String)}
            onChange={(ids) => setFilters({ ...filters, assigneeIds: ids.map(Number) })}
          />
          <MultiFilter
            label="Labels"
            options={(labelsQuery.data ?? []).map((label) => ({ value: String(label.id), label: label.name }))}
            selected={filters.labelIds.map(String)}
            onChange={(ids) => setFilters({ ...filters, labelIds: ids.map(Number) })}
          />
          <Select
            label="Due soon"
            value={filters.dueWithin ?? ''}
            options={DUE_WINDOWS}
            placeholder="Any time"
            onChange={(value) => setFilters({ ...filters, dueWithin: value === '' ? undefined : value })}
          />
          <Select
            label="Sort by"
            value={filters.sort}
            options={SORTS}
            onChange={(value) => setFilters({ ...filters, sort: value })}
          />
          <Button
            onClick={() => {
              setFilters({ ...EMPTY_FILTERS, q: filters.q });
              toast.info('Filters cleared');
            }}
          >
            Clear filters
          </Button>
        </div>
      ) : null}

      {results.error !== null ? (
        <ErrorState error={results.error} title="Could not run that search" onRetry={results.refetch} />
      ) : results.isLoading ? (
        <div className="table-wrap">
          {Array.from({ length: 6 }, (_unused, index) => (
            <div key={index} style={{ padding: 12, borderBottom: '1px solid var(--border)' }}>
              <div className="skeleton" style={{ height: 14, width: `${40 + (index % 3) * 20}%` }} />
            </div>
          ))}
        </div>
      ) : (results.data?.issues.length ?? 0) === 0 ? (
        <EmptyState
          icon="🔍"
          title="No issues match these filters"
          description="Try widening the search, or create the first issue for this project."
          action={{
            label: 'New issue',
            onClick: () => void navigate(`/p/${projectId}/issues/new`),
          }}
        />
      ) : (
        <div className="table-wrap">
          <table className="data">
            <caption className="visually-hidden">Issues matching the current filters</caption>
            <thead>
              <tr>
                <th scope="col">Key</th>
                <th scope="col">Title</th>
                <th scope="col">Type</th>
                <th scope="col">Priority</th>
                <th scope="col">State</th>
                <th scope="col">Assignee</th>
                <th scope="col">Due</th>
                <th scope="col">Updated</th>
              </tr>
            </thead>
            <tbody>
              {(results.data?.issues ?? []).map((issue) => (
                <IssueRow key={issue.id} issue={issue} projectId={projectId} labelsById={labelsById} />
              ))}
            </tbody>
          </table>
        </div>
      )}

      {results.data !== null && results.data.warnings.length > 0 ? (
        <p className="subtle">Note: {results.data.warnings.join(' ')}</p>
      ) : null}
    </div>
  );
}

function IssueRow({
  issue,
  projectId,
  labelsById,
}: {
  issue: IssueSummary;
  projectId: ReturnType<typeof asProjectId>;
  labelsById: ReadonlyMap<number, string>;
}): JSX.Element {
  return (
    <tr>
      <td>
        <Link to={`/p/${projectId}/issues/${issue.id}`} className="mono">
          {issue.key}
        </Link>
      </td>
      <td>
        <Link to={`/p/${projectId}/issues/${issue.id}`}>{issue.title}</Link>
        {issue.labelIds.length > 0 ? (
          <div className="row" style={{ gap: 4, marginTop: 4 }}>
            {issue.labelIds.slice(0, 4).map((labelId) => {
              const name = labelsById.get(labelId);
              return name === undefined ? null : <Badge key={labelId}>{name}</Badge>;
            })}
          </div>
        ) : null}
      </td>
      <td className="nowrap">{ISSUE_TYPE_LABEL[issue.type]}</td>
      <td className="nowrap">{PRIORITY_LABEL[issue.priority]}</td>
      <td className="nowrap">
        <Badge dot>{issue.state.replace('_', ' ')}</Badge>
      </td>
      <td className="nowrap">
        {issue.assigneeName === null ? (
          <span className="subtle">Unassigned</span>
        ) : (
          <span className="row" style={{ gap: 6 }}>
            <Avatar name={issue.assigneeName} size="sm" />
            {issue.assigneeName}
          </span>
        )}
      </td>
      <td className="nowrap">
        {issue.dueDate === null ? (
          <span className="subtle">—</span>
        ) : (
          <span className={issue.isOverdue ? 'badge badge--danger' : undefined}>
            {formatDate(issue.dueDate)}
          </span>
        )}
      </td>
      <td className="nowrap subtle">{formatRelative(issue.lastActivityAt)}</td>
    </tr>
  );
}

export interface MultiFilterProps {
  label: string;
  options: ReadonlyArray<{ value: string; label: string }>;
  selected: readonly string[];
  onChange: (values: string[]) => void;
}

/** Checkbox dropdown; closes on outside click and keeps the trigger a button. */
function MultiFilter({ label, options, selected, onChange }: MultiFilterProps): JSX.Element {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const summary =
    selected.length === 0
      ? 'Any'
      : selected.length === 1
        ? (options.find((option) => option.value === selected[0])?.label ?? '1 selected')
        : `${selected.length} selected`;

  useEffect(() => {
    if (!open) return undefined;
    const onPointerDown = (event: MouseEvent): void => {
      if (rootRef.current !== null && !rootRef.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    return () => document.removeEventListener('mousedown', onPointerDown);
  }, [open]);

  return (
    <div className="field multi-select" ref={rootRef}>
      <span className="field-label" id={`multi-${label}`}>
        {label}
      </span>
      <button
        type="button"
        className="input"
        style={{ textAlign: 'left', cursor: 'pointer' }}
        aria-haspopup="true"
        aria-expanded={open}
        aria-labelledby={`multi-${label}`}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="truncate" style={{ display: 'block' }}>
          {summary}
        </span>
      </button>
      {open ? (
        <div className="multi-select-panel" role="group" aria-label={label}>
          {options.length === 0 ? (
            <p className="subtle" style={{ padding: 6 }}>
              No options
            </p>
          ) : (
            options.map((option) => (
              <label key={option.value} className="menu-item" style={{ cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={selected.includes(option.value)}
                  onChange={(event) => {
                    onChange(
                      event.target.checked
                        ? [...selected, option.value]
                        : selected.filter((value) => value !== option.value),
                    );
                  }}
                />
                <span className="truncate">{option.label}</span>
              </label>
            ))
          )}
        </div>
      ) : null}
    </div>
  );
}
