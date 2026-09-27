import type { ReactNode } from 'react';
import { cx } from '../lib/format';

export interface Column<T> {
  key: string;
  header: ReactNode;
  render: (row: T) => ReactNode;
  /** Right-aligned, tabular numerals. */
  numeric?: boolean;
  width?: string;
}

export interface DataTableProps<T> {
  caption: string;
  columns: ReadonlyArray<Column<T>>;
  rows: readonly T[];
  rowKey: (row: T) => string | number;
  onRowClick?: (row: T) => void;
  emptyMessage?: string;
}

/** Semantic table with sticky headers; used for issues, runs, conflicts, audit. */
export function DataTable<T>({
  caption,
  columns,
  rows,
  rowKey,
  onRowClick,
  emptyMessage = 'No rows',
}: DataTableProps<T>): JSX.Element {
  return (
    <div className="table-wrap">
      <table className="data">
        <caption className="visually-hidden">{caption}</caption>
        <thead>
          <tr>
            {columns.map((column) => (
              <th key={column.key} scope="col" className={cx(column.numeric && 'num')} style={column.width !== undefined ? { width: column.width } : undefined}>
                {column.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td colSpan={columns.length} className="muted" style={{ textAlign: 'center', padding: 24 }}>
                {emptyMessage}
              </td>
            </tr>
          ) : (
            rows.map((row) => (
              <tr
                key={rowKey(row)}
                onClick={onRowClick !== undefined ? () => onRowClick(row) : undefined}
                style={onRowClick !== undefined ? { cursor: 'pointer' } : undefined}
              >
                {columns.map((column) => (
                  <td key={column.key} className={cx(column.numeric && 'num')}>
                    {column.render(row)}
                  </td>
                ))}
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}
