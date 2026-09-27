/**
 * Kanban board.
 *
 * One column per workflow status in `position` order. A drag applies the move
 * locally first (optimistic), posts it, and reverts with a toast if the server
 * rejects it. Remote `board.updated` events are merged on top of local state, so
 * a move made by a teammate appears without a refetch.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useQuery } from '../api/hooks';
import { boardApi, projectApi } from '../api/repo';
import { asIssueId, asProjectId, type BoardUpdate, type IssueId, type IssueSummary, type Label } from '../api/types';
import { toBoardUpdate } from '../api/normalize';
import { useProjects } from '../projects/ProjectContext';
import { useRealtime, useRealtimeEvent } from '../realtime/useRealtime';
import { Badge } from '../components/Badge';
import { Button } from '../components/Button';
import { EmptyState, ErrorState } from '../components/EmptyState';
import { IssueCard } from '../components/IssueCard';
import { Skeleton } from '../components/Skeleton';
import { useToast } from '../components/Toast';

interface Column {
  statusId: number;
  key: string;
  name: string;
  color: string;
  wipLimit: number | null;
  issues: IssueSummary[];
}

function toColumns(board: BoardUpdate): Column[] {
  return board.columns.map((column) => ({
    statusId: column.statusId,
    key: column.key,
    name: column.name,
    color: column.color,
    wipLimit: column.wipLimit,
    issues: [...column.issues].sort((a, b) => a.position - b.position),
  }));
}

export function Board(): JSX.Element {
  const params = useParams();
  const projectId = asProjectId(Number(params.projectId));
  const { activeProject } = useProjects();
  const toast = useToast();
  const { subscribeProject } = useRealtime();

  const boardQuery = useQuery<BoardUpdate>(
    (signal) => boardApi.get(projectId, signal),
    [projectId],
  );
  const labelsQuery = useQuery<Label[]>((signal) => projectApi.labels(projectId, signal), [projectId]);

  const [columns, setColumns] = useState<Column[]>([]);
  const [dragging, setDragging] = useState<IssueId | null>(null);
  const [dropTarget, setDropTarget] = useState<number | null>(null);
  // Retained so a failed move can restore the exact previous layout.
  const previousColumns = useRef<Column[] | null>(null);

  const labelsById = useMemo(
    () => new Map((labelsQuery.data ?? []).map((label) => [label.id, label.name])),
    [labelsQuery.data],
  );

  useEffect(() => {
    if (boardQuery.data !== null) setColumns(toColumns(boardQuery.data));
  }, [boardQuery.data]);

  useEffect(
    () => subscribeProject(projectId),
    [projectId, subscribeProject],
  );

  /**
   * Merge a remote board payload. Columns absent from the payload keep their
   * local cards, so a partial broadcast never wipes the board.
   */
  const mergeRemote = useCallback((incoming: BoardUpdate) => {
    if (incoming.projectId !== projectId) return;
    setColumns((current) => {
      const byStatus = new Map(incoming.columns.map((column) => [column.statusId, column]));
      const removed = new Set(incoming.removedIssueIds);
      const next = current.map((column) => {
        const update = byStatus.get(column.statusId);
        if (update === undefined) {
          return { ...column, issues: column.issues.filter((issue) => !removed.has(issue.id)) };
        }
        return {
          ...column,
          issues: [...update.issues].sort((a, b) => a.position - b.position),
        };
      });
      // A column the server knows about but we have not seen yet.
      for (const column of incoming.columns) {
        if (!next.some((existing) => existing.statusId === column.statusId)) {
          next.push({
            statusId: column.statusId,
            key: column.key,
            name: column.name,
            color: column.color,
            wipLimit: column.wipLimit,
            issues: [...column.issues].sort((a, b) => a.position - b.position),
          });
        }
      }
      return next.sort((a, b) => a.statusId - b.statusId);
    });
  }, [projectId]);

  useRealtimeEvent('board.updated', (message) => {
    if (message.projectId !== undefined && message.projectId !== projectId) return;
    mergeRemote(toBoardUpdate(message.data, projectId));
  });

  useRealtimeEvent('issue.deleted', (message) => {
    const issueId = message.issueId;
    if (issueId === undefined) return;
    setColumns((current) =>
      current.map((column) => ({ ...column, issues: column.issues.filter((i) => i.id !== issueId) })),
    );
  });

  const move = useCallback(
    async (issueId: IssueId, toStatusId: number) => {
      const from = columns.find((column) => column.issues.some((issue) => issue.id === issueId));
      if (from === undefined || from.statusId === toStatusId) return;

      const card = from.issues.find((issue) => issue.id === issueId);
      if (card === undefined) return;

      previousColumns.current = columns;
      const target = columns.find((column) => column.statusId === toStatusId);
      // Fractional position so the server can order without a full reorder.
      const lastPosition = target?.issues[target.issues.length - 1]?.position ?? 0;
      const position = lastPosition + 1024;

      setColumns((current) =>
        current.map((column) => {
          if (column.statusId === from.statusId) {
            return { ...column, issues: column.issues.filter((issue) => issue.id !== issueId) };
          }
          if (column.statusId === toStatusId) {
            return { ...column, issues: [...column.issues, { ...card, position }] };
          }
          return column;
        }),
      );

      try {
        await boardApi.move(projectId, { issueId: issueId as number, toStatusId, position });
      } catch (error) {
        const snapshot = previousColumns.current;
        if (snapshot !== null) setColumns(snapshot);
        toast.apiError(error);
      } finally {
        previousColumns.current = null;
      }
    },
    [columns, projectId, toast],
  );

  const isLoading = boardQuery.isLoading;
  const error = boardQuery.error;

  return (
    <div className="stack" style={{ flex: 1, minHeight: 0 }}>
      <div className="page-header" style={{ marginBottom: 0, padding: 'var(--space-4) var(--space-4) 0' }}>
        <div className="page-title-group">
          <h1>Board</h1>
          <p className="page-subtitle">
            {activeProject === null
              ? 'Drag cards between columns to change status.'
              : `${activeProject.key} · drag cards between columns to change status.`}
          </p>
        </div>
        <div className="toolbar">
          <Button onClick={boardQuery.refetch} loading={boardQuery.isRefreshing}>
            Refresh
          </Button>
          <Link className="btn btn--primary" to={`/p/${projectId}/issues/new`}>
            New issue
          </Link>
        </div>
      </div>

      {isLoading ? (
        <BoardSkeleton />
      ) : error !== null ? (
        <ErrorState error={error} title="Could not load the board" onRetry={boardQuery.refetch} />
      ) : columns.length === 0 ? (
        <EmptyState
          icon="🗂"
          title="This project has no workflow columns"
          description="Add statuses in Settings → Workflow, then create an issue to start the board."
        />
      ) : (
        <div className="board" role="list" aria-label="Kanban board">
          {columns.map((column) => {
            const overWip = column.wipLimit !== null && column.issues.length > column.wipLimit;
            const ratio =
              column.wipLimit === null || column.wipLimit === 0
                ? 0
                : Math.min(1, column.issues.length / column.wipLimit);
            return (
              <section
                key={column.statusId}
                role="listitem"
                aria-label={`${column.name}, ${column.issues.length} issues`}
                className={[
                  'board-column',
                  overWip ? 'is-over-wip' : '',
                  dropTarget === column.statusId ? 'is-drop-target' : '',
                ]
                  .filter((c) => c !== '')
                  .join(' ')}
                onDragOver={(event) => {
                  if (dragging === null) return;
                  event.preventDefault();
                  event.dataTransfer.dropEffect = 'move';
                  setDropTarget(column.statusId);
                }}
                onDragLeave={() => setDropTarget((current) => (current === column.statusId ? null : current))}
                onDrop={(event) => {
                  event.preventDefault();
                  setDropTarget(null);
                  const issueId = Number(event.dataTransfer.getData('text/plain'));
                  setDragging(null);
                  if (Number.isFinite(issueId) && issueId > 0) {
                    void move(asIssueId(issueId), column.statusId);
                  }
                }}
              >
                <header className="board-column-header">
                  <span className="board-column-bar" style={{ background: column.color }} aria-hidden="true" />
                  <div className="grow" style={{ minWidth: 0 }}>
                    <div className="row" style={{ gap: 6 }}>
                      <strong className="truncate">{column.name}</strong>
                      <span className="subtle">{column.issues.length}</span>
                      {column.wipLimit !== null ? (
                        <Badge tone={overWip ? 'danger' : 'neutral'} title="Work-in-progress limit">
                          WIP {column.issues.length}/{column.wipLimit}
                        </Badge>
                      ) : null}
                    </div>
                    {column.wipLimit !== null ? (
                      <div
                        className={overWip ? 'wip-meter is-over' : 'wip-meter'}
                        role="meter"
                        aria-valuenow={column.issues.length}
                        aria-valuemin={0}
                        aria-valuemax={column.wipLimit}
                        aria-label={`${column.name} work in progress`}
                        style={{ marginTop: 6 }}
                      >
                        <span style={{ width: `${Math.round(ratio * 100)}%` }} />
                      </div>
                    ) : null}
                  </div>
                </header>
                <div className="board-column-body">
                  {column.issues.length === 0 ? (
                    <p className="subtle" style={{ padding: 8, textAlign: 'center' }}>
                      {dragging === null ? 'No issues' : 'Drop here'}
                    </p>
                  ) : (
                    column.issues.map((issue) => (
                      <IssueCard
                        key={issue.id}
                        issue={issue}
                        projectId={projectId}
                        draggable
                        dragging={dragging === issue.id}
                        labels={labelsById}
                        onDragStart={(domEvent) => {
                          domEvent.dataTransfer.effectAllowed = 'move';
                          domEvent.dataTransfer.setData('text/plain', String(issue.id));
                          setDragging(issue.id);
                        }}
                        onDragEnd={() => {
                          setDragging(null);
                          setDropTarget(null);
                        }}
                      />
                    ))
                  )}
                </div>
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}

function BoardSkeleton(): JSX.Element {
  return (
    <div className="board" aria-hidden="true">
      {[0, 1, 2, 3].map((column) => (
        <div key={column} className="board-column">
          <div className="board-column-header">
            <Skeleton width="60%" height="16px" />
          </div>
          <div className="board-column-body">
            {[0, 1, 2].map((card) => (
              <Skeleton key={card} height="76px" />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
