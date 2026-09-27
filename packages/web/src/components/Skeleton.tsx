import { cx } from '../lib/format';

export interface SkeletonProps {
  width?: string;
  height?: string;
  className?: string;
}

/**
 * A fixed-size placeholder. Used instead of a spinner wherever the final shape
 * is known, so nothing reflows when the data lands.
 */
export function Skeleton({ width = '100%', height = '14px', className }: SkeletonProps): JSX.Element {
  return <div className={cx('skeleton', className)} style={{ width, height }} aria-hidden="true" />;
}

/** N skeleton rows shaped like a list or table body. */
export function SkeletonRows({
  rows = 4,
  height = '44px',
}: {
  rows?: number;
  height?: string;
}): JSX.Element {
  return (
    <div className="stack-sm" aria-hidden="true">
      {Array.from({ length: rows }, (_unused, index) => (
        <Skeleton key={index} height={height} />
      ))}
    </div>
  );
}
