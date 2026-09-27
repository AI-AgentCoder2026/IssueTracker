/**
 * `WidgetData` renderers.
 *
 * All 16 `WidgetType` values are rendered through these six components, because
 * the server decides which data kind a widget produces. The registry in
 * `WidgetCard.tsx` maps every widget type onto a renderer, so adding a type to
 * `WIDGET_TYPES` without a renderer is a compile error.
 */

import type { WidgetData } from '../../api/types';
import { formatCellValue } from '../../lib/format';
import { EmptyState } from '../EmptyState';

export function EmptyWidget({ data }: { data: Extract<WidgetData, { kind: 'empty' }> }): JSX.Element {
  return <EmptyState icon="◌" title="Nothing to show" description={data.reason} />;
}

export function StatWidget({ data }: { data: Extract<WidgetData, { kind: 'stat' }> }): JSX.Element {
  const hasDelta = data.delta !== undefined && data.delta !== null && Number.isFinite(data.delta);
  const up = hasDelta && (data.delta as number) > 0;
  const flat = hasDelta && (data.delta as number) === 0;
  return (
    <div className="stack-sm">
      <span className="stat-value">{data.value}</span>
      <span className="stat-label">{data.label}</span>
      {hasDelta && !flat ? (
        <span className={up ? 'stat-delta is-up' : 'stat-delta is-down'}>
          {up ? '▲' : '▼'} {Math.abs(data.delta as number)} vs previous
        </span>
      ) : null}
    </div>
  );
}

export function BarWidget({ data }: { data: Extract<WidgetData, { kind: 'bar' }> }): JSX.Element {
  if (data.series.length === 0) {
    return <EmptyState icon="📊" title="No data" description="Nothing matched this widget's filters." />;
  }
  const max = Math.max(1, ...data.series.map((entry) => Math.abs(entry.value)));
  return (
    <div className="stack-sm">
      {data.series.map((entry) => (
        <div key={entry.label} className="bar-row">
          <span className="truncate" title={entry.label}>
            {entry.label}
          </span>
          <span className="bar-track">
            <span
              className="bar-fill"
              style={{
                width: `${Math.round((Math.abs(entry.value) / max) * 100)}%`,
                ...(entry.color !== undefined ? { background: entry.color } : {}),
              }}
            />
          </span>
          <span className="num nowrap" style={{ fontVariantNumeric: 'tabular-nums' }}>
            {entry.value}
          </span>
        </div>
      ))}
    </div>
  );
}

export function LineWidget({ data }: { data: Extract<WidgetData, { kind: 'line' }> }): JSX.Element {
  if (data.points.length === 0) {
    return <EmptyState icon="📈" title="No data" description="There are no points in this range yet." />;
  }
  const values = data.points.map((point) => point.value ?? 0);
  const max = Math.max(1, ...values);
  return (
    <div className="line-chart" role="img" aria-label={`Trend with ${data.points.length} points`}>
      {data.points.map((point, index) => (
        <div
          key={`${point.label}-${index}`}
          className="line-col"
          title={`${point.label}: ${point.value === null ? 'no data' : point.value}`}
        >
          <span
            className={point.value === null ? 'line-bar is-null' : 'line-bar'}
            style={{ height: `${point.value === null ? 2 : Math.max(2, (point.value / max) * 100)}%` }}
          />
          {index % Math.ceil(data.points.length / 12) === 0 ? (
            <span className="line-label">{point.label}</span>
          ) : null}
        </div>
      ))}
    </div>
  );
}

export function TableWidget({ data }: { data: Extract<WidgetData, { kind: 'table' }> }): JSX.Element {
  if (data.rows.length === 0 || data.columns.length === 0) {
    return <EmptyState icon="🗂" title="No rows" description="Nothing matched this widget's filters." />;
  }
  return (
    <table className="data">
      <thead>
        <tr>
          {data.columns.map((column) => (
            <th key={column} scope="col">
              {column}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {data.rows.map((row, rowIndex) => (
          <tr key={rowIndex}>
            {data.columns.map((column) => (
              <td key={column}>{formatCellValue(row[column])}</td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function ListWidget({ data }: { data: Extract<WidgetData, { kind: 'list' }> }): JSX.Element {
  if (data.items.length === 0) {
    return <EmptyState icon="📋" title="Nothing here" description="This widget has no items to show." />;
  }
  return (
    <ul className="widget-list" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
      {data.items.map((item) => {
        const body = (
          <>
            <span className="truncate" style={{ fontWeight: 500 }}>
              {item.title}
            </span>
            {item.subtitle !== undefined ? (
              <span className="subtle truncate">{item.subtitle}</span>
            ) : null}
          </>
        );
        return (
          <li key={item.id}>
            {item.href !== undefined ? (
              <a className="widget-list-item" href={item.href}>
                {body}
              </a>
            ) : (
              <div className="widget-list-item">{body}</div>
            )}
          </li>
        );
      })}
    </ul>
  );
}
