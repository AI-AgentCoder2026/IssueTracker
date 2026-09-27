/**
 * Widget frame plus the `WidgetType` â†’ renderer registry.
 *
 * `WIDGET_RENDERERS` is typed as `Record<WidgetType, â€¦>`, so every one of the 16
 * widget types in `WIDGET_TYPES` must resolve to a renderer or the build fails.
 * Which renderer runs is decided by the payload's `kind`, which the server
 * chooses per widget; list items carry their own `href` so the UI needs no
 * client-side knowledge of what each widget contains.
 */

import { WIDGET_TYPE_LABEL, type RenderedWidget, type WidgetType } from '../../api/types';
import { cx } from '../../lib/format';
import { Button } from '../Button';
import { useConfirm } from '../Modal';
import { Skeleton } from '../Skeleton';
import {
  BarWidget,
  EmptyWidget,
  LineWidget,
  ListWidget,
  StatWidget,
  TableWidget,
} from './DataRenderers';

/** Props every widget renderer receives. */
export interface WidgetRendererProps {
  widget: RenderedWidget;
}

/** Turns a widget payload into the one renderer that matches its `kind`. */
export function renderWidgetData({ widget }: WidgetRendererProps): JSX.Element {
  switch (widget.data.kind) {
    case 'table':
      return <TableWidget data={widget.data} />;
    case 'bar':
      return <BarWidget data={widget.data} />;
    case 'line':
      return <LineWidget data={widget.data} />;
    case 'stat':
      return <StatWidget data={widget.data} />;
    case 'list':
      return <ListWidget data={widget.data} />;
    case 'empty':
      return <EmptyWidget data={widget.data} />;
  }
}

type WidgetRenderer = (props: WidgetRendererProps) => JSX.Element;

export const WIDGET_RENDERERS: Record<WidgetType, WidgetRenderer> = {
  issue_list: renderWidgetData,
  status_breakdown: renderWidgetData,
  priority_breakdown: renderWidgetData,
  burndown: renderWidgetData,
  velocity: renderWidgetData,
  sla_countdown: renderWidgetData,
  overdue_watchlist: renderWidgetData,
  unassigned_queue: renderWidgetData,
  throughput: renderWidgetData,
  workload_by_assignee: renderWidgetData,
  age_distribution: renderWidgetData,
  recent_activity: renderWidgetData,
  cycle_time: renderWidgetData,
  type_breakdown: renderWidgetData,
  blocked_dependencies: renderWidgetData,
  gitlab_sync_health: renderWidgetData,
};

export interface WidgetCardProps {
  widget: RenderedWidget;
  isLoading?: boolean;
  editMode?: boolean;
  isDragging?: boolean;
  isDropTarget?: boolean;
  onDragStart?: (event: React.DragEvent<HTMLElement>) => void;
  onDragOver?: (event: React.DragEvent<HTMLElement>) => void;
  onDragLeave?: () => void;
  onDrop?: (event: React.DragEvent<HTMLElement>) => void;
  onDragEnd?: () => void;
  onRemove?: () => void;
}

/** One dashboard cell: header, widget-type label and the rendered payload. */
export function WidgetCard({
  widget,
  isLoading = false,
  editMode = false,
  isDragging = false,
  isDropTarget = false,
  onDragStart,
  onDragOver,
  onDragLeave,
  onDrop,
  onDragEnd,
  onRemove,
}: WidgetCardProps): JSX.Element {
  const { confirm, dialog } = useConfirm();
  const Renderer: WidgetRenderer = WIDGET_RENDERERS[widget.type] ?? renderWidgetData;

  return (
    <section
      className={cx(
        'widget',
        editMode && 'is-editable',
        isDragging && 'is-dragging',
        isDropTarget && 'is-drop-target',
      )}
      style={{
        gridColumn: `${widget.position.x + 1} / span ${widget.position.w}`,
        gridRow: `${widget.position.y + 1} / span ${widget.position.h}`,
      }}
      draggable={editMode}
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      onDragEnd={onDragEnd}
      aria-label={`${widget.title} (${WIDGET_TYPE_LABEL[widget.type]})`}
    >
      <header className="widget-header">
        <div className="truncate">
          <strong style={{ fontWeight: 600 }}>{widget.title}</strong>
          <div className="subtle truncate">{WIDGET_TYPE_LABEL[widget.type]}</div>
        </div>
        {onRemove !== undefined ? (
          <Button
            size="sm"
            variant="ghost"
            iconOnly
            aria-label={`Remove widget ${widget.title}`}
            onClick={async () => {
              const ok = await confirm({
                title: 'Remove widget',
                message: `Remove â€œ${widget.title}â€ from this dashboard?`,
                confirmLabel: 'Remove',
                destructive: true,
              });
              if (ok) onRemove();
            }}
          >
            âœ•
          </Button>
        ) : null}
      </header>
      <div className="widget-body">
        {isLoading ? (
          <div className="stack-sm">
            <Skeleton height="12px" width="60%" />
            <Skeleton height="12px" width="90%" />
            <Skeleton height="12px" width="75%" />
          </div>
        ) : (
          <Renderer widget={widget} />
        )}
      </div>
      {dialog}
    </section>
  );
}
