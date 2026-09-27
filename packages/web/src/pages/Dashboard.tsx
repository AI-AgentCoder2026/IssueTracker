/**
 * Dashboards.
 *
 * `GET /api/dashboards/visible?projectId=` returns the dashboards the viewer's
 * roles grant, each with its widget layout; `GET /api/dashboards/:id/render`
 * returns the per-viewer data. In edit mode widgets are draggable and the new
 * layout is persisted with `POST /api/dashboards/:id/widgets/reorder`.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery } from '../api/hooks';
import { dashboardApi } from '../api/repo';
import {
  WIDGET_TYPES,
  WIDGET_TYPE_LABEL,
  asProjectId,
  type Dashboard,
  type RenderedDashboard,
  type WidgetPosition,
  type WidgetType,
} from '../api/types';
import { Badge } from '../components/Badge';
import { Button } from '../components/Button';
import { EmptyState, ErrorState } from '../components/EmptyState';
import { Select } from '../components/Select';
import { SkeletonRows } from '../components/Skeleton';
import { useToast } from '../components/Toast';
import { WidgetCard } from '../components/widgets';

const GRID_COLUMNS = 12;

/** Lays widgets out left-to-right, wrapping into a new row at the grid edge. */
function normaliseLayout(widgets: RenderedDashboard['widgets']): Map<number, WidgetPosition> {
  const positions = new Map<number, WidgetPosition>();
  let cursorX = 0;
  let cursorY = 0;
  let rowHeight = 0;
  const sorted = [...widgets].sort(
    (a, b) => a.position.y - b.position.y || a.position.x - b.position.x,
  );
  for (const widget of sorted) {
    const w = Math.min(Math.max(1, widget.position.w), GRID_COLUMNS);
    const h = Math.max(1, widget.position.h);
    if (cursorX + w > GRID_COLUMNS) {
      cursorX = 0;
      cursorY += rowHeight;
      rowHeight = 0;
    }
    positions.set(widget.id, { x: cursorX, y: cursorY, w, h });
    cursorX += w;
    rowHeight = Math.max(rowHeight, h);
  }
  return positions;
}

export function Dashboard(): JSX.Element {
  const params = useParams();
  const projectId = asProjectId(Number(params.projectId));
  const toast = useToast();
  const [searchParams, setSearchParams] = useSearchParams();

  const dashboardsQuery = useQuery<Dashboard[]>(
    (signal) => dashboardApi.visible(projectId, signal),
    [projectId],
  );
  const dashboards = useMemo(() => dashboardsQuery.data ?? [], [dashboardsQuery.data]);
  const selectedId = Number(searchParams.get('dashboard'));
  const selected =
    dashboards.find((dashboard) => dashboard.id === selectedId) ?? dashboards[0] ?? null;

  const [editMode, setEditMode] = useState(false);
  const [positions, setPositions] = useState<Map<number, WidgetPosition>>(new Map());
  const draggingId = useRef<number | null>(null);
  const [dropTargetId, setDropTargetId] = useState<number | null>(null);

  const renderedQuery = useQuery<RenderedDashboard>(
    (signal) => dashboardApi.render(selected!.id as number, signal),
    [selected?.id],
    { enabled: selected !== null },
  );

  useEffect(() => {
    setPositions(new Map());
    setEditMode(false);
  }, [selected?.id]);

  const widgets = useMemo(() => {
    const list = renderedQuery.data?.widgets ?? [];
    if (!editMode) return list;
    return list.map((widget) => ({ ...widget, position: positions.get(widget.id) ?? widget.position }));
  }, [renderedQuery.data, editMode, positions]);

  const reorder = useMutation<Array<{ id: number; position: WidgetPosition }>, unknown>(
    (items) => dashboardApi.reorder(selected!.id as number, { widgets: items }),
    {
      onSuccess: () => {
        toast.success('Layout saved');
        setEditMode(false);
        renderedQuery.refetch();
      },
      onError: (error) => {
        toast.apiError(error);
        renderedQuery.refetch();
      },
    },
  );

  const onDrop = useCallback(
    (targetId: number) => {
      const sourceId = draggingId.current;
      draggingId.current = null;
      setDropTargetId(null);
      if (sourceId === null || sourceId === targetId) return;

      const list = renderedQuery.data?.widgets ?? [];
      const layout = normaliseLayout(list);
      const source = layout.get(sourceId);
      const target = layout.get(targetId);
      if (source === undefined || target === undefined) return;

      // Swap the two slots, then re-flow so nothing overlaps.
      const next = new Map(layout);
      next.set(sourceId, target);
      next.set(targetId, source);
      setPositions(next);
    },
    [renderedQuery.data],
  );

  const saveLayout = (): void => {
    const list = renderedQuery.data?.widgets ?? [];
    const layout = positions.size === 0 ? normaliseLayout(list) : positions;
    void reorder.mutate(
      list.map((widget) => ({ id: widget.id, position: layout.get(widget.id) ?? widget.position })),
    );
  };

  const addWidget = useCallback(
    async (type: WidgetType = 'issue_list'): Promise<void> => {
      if (selected === null) return;
      const list = renderedQuery.data?.widgets ?? [];
      const layout = positions.size === 0 ? normaliseLayout(list) : positions;
      const nextY =
        layout.size === 0 ? 0 : Math.max(...[...layout.values()].map((position) => position.y + position.h));
      try {
        await dashboardApi.addWidget(selected.id as number, {
          type,
          title: WIDGET_TYPE_LABEL[type],
          position: { x: 0, y: nextY, w: 4, h: 3 },
          filters: {},
          limit: 10,
          hiddenFromRoles: [],
        });
        toast.success(`Added ${WIDGET_TYPE_LABEL[type]}`);
        renderedQuery.refetch();
      } catch (error) {
        toast.apiError(error);
      }
    },
    [positions, renderedQuery, selected, toast],
  );

  const removeWidget = useCallback(
    async (widgetId: number): Promise<void> => {
      if (selected === null) return;
      try {
        await dashboardApi.removeWidget(selected.id as number, widgetId);
        toast.success('Widget removed');
        renderedQuery.refetch();
      } catch (error) {
        toast.apiError(error);
      }
    },
    [renderedQuery, selected, toast],
  );

  if (dashboardsQuery.error !== null) {
    return (
      <ErrorState
        error={dashboardsQuery.error}
        title="Could not load dashboards"
        onRetry={dashboardsQuery.refetch}
      />
    );
  }

  if (dashboardsQuery.isLoading) {
    return (
      <div className="stack">
        <SkeletonRows rows={2} height="30px" />
        <div className="dash-grid">
          {[0, 1, 2, 3].map((index) => (
            <div key={index} className="widget" style={{ gridColumn: 'span 4', gridRow: 'span 3' }}>
              <div className="widget-body">
                <SkeletonRows rows={3} />
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (selected === null) {
    return (
      <EmptyState
        icon="📊"
        title="No dashboards are visible to you"
        description="Dashboards are scoped by role. Ask a project admin to add your role to one of the default dashboards."
      />
    );
  }

  return (
    <div className="stack">
      <div className="page-header">
        <div className="page-title-group">
          <h1>Dashboards</h1>
          <p className="page-subtitle">
            {selected.description === '' ? 'Role-scoped views for this project.' : selected.description}
          </p>
        </div>
        <div className="toolbar">
          {dashboards.length > 1 ? (
            <div style={{ minWidth: 220 }}>
              <Select
                label="Dashboard"
                value={selected.id as number}
                hideLabel
                options={dashboards.map((dashboard) => ({ value: dashboard.id as number, label: dashboard.name }))}
                onChange={(id) => setSearchParams({ dashboard: String(id) })}
              />
            </div>
          ) : null}
          {editMode ? (
            <>
              <Button onClick={() => setEditMode(false)} disabled={reorder.isPending}>
                Cancel
              </Button>
              <Button variant="primary" onClick={saveLayout} loading={reorder.isPending}>
                Save layout
              </Button>
            </>
          ) : (
            <Button onClick={() => setEditMode(true)}>Arrange</Button>
          )}
        </div>
      </div>

      <div className="row" style={{ gap: 6 }}>
        {selected.roles.length === 0 ? (
          <Badge>visible to all project members</Badge>
        ) : (
          selected.roles.map((role) => <Badge key={role}>{role}</Badge>)
        )}
        {selected.isDefault ? <Badge tone="accent">default</Badge> : null}
        {editMode ? <Badge tone="warning">drag widgets to rearrange</Badge> : null}
      </div>

      {renderedQuery.error !== null ? (
        <ErrorState
          error={renderedQuery.error}
          title="Could not render this dashboard"
          onRetry={renderedQuery.refetch}
        />
      ) : renderedQuery.isLoading ? (
        <div className="dash-grid">
          {[0, 1, 2, 3, 4, 5].map((index) => (
            <div key={index} className="widget" style={{ gridColumn: 'span 4', gridRow: 'span 3' }}>
              <div className="widget-body">
                <SkeletonRows rows={4} />
              </div>
            </div>
          ))}
        </div>
      ) : widgets.length === 0 ? (
        <EmptyState
          icon="📊"
          title="This dashboard has no widgets"
          description="Add one with the button below to start tracking this view."
          action={{ label: 'Add a widget', onClick: () => void addWidget() }}
        />
      ) : (
        <div className="dash-grid">
          {widgets.map((widget) => (
            <WidgetCard
              key={widget.id}
              widget={widget}
              editMode={editMode}
              isDragging={draggingId.current === widget.id}
              isDropTarget={dropTargetId === widget.id}
              onDragStart={() => {
                draggingId.current = widget.id;
              }}
              onDragOver={(event) => {
                if (!editMode) return;
                event.preventDefault();
                setDropTargetId(widget.id);
              }}
              onDragLeave={() => setDropTargetId(null)}
              onDrop={(event) => {
                if (!editMode) return;
                event.preventDefault();
                onDrop(widget.id);
              }}
              onDragEnd={() => {
                draggingId.current = null;
                setDropTargetId(null);
              }}
              onRemove={editMode ? () => void removeWidget(widget.id) : undefined}
            />
          ))}
        </div>
      )}

      <div className="row">
        <Select
          label="Add a widget"
          value="issue_list"
          options={WIDGET_TYPES.map((type) => ({ value: type, label: WIDGET_TYPE_LABEL[type] }))}
          onChange={(type) => void addWidget(type)}
          hideLabel
        />
      </div>
    </div>
  );
}
