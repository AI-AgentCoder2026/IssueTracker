/**
 * Export control.
 *
 * Export is `POST` because the request carries a filter, and it answers with a
 * file rather than JSON — so it cannot go through the normal request path,
 * which would try to parse a CSV as JSON.
 *
 * The scope is explicit rather than implicit: if issues are selected, the
 * selection is what gets exported, and the button says so. Otherwise the
 * current filters are exported, which is the thing a user means when they hit
 * this on a filtered list.
 */

import { useState } from 'react';
import { useMutation } from '../api/hooks';
import { saveFile } from '../api/client';
import { exportApi } from '../api/repo';
import { Button } from './Button';
import { Select } from './Select';
import { useToast } from './Toast';

export type ExportFormat = 'json' | 'csv' | 'markdown';

const FORMATS: Array<{ value: ExportFormat; label: string }> = [
  { value: 'csv', label: 'CSV' },
  { value: 'json', label: 'JSON' },
  { value: 'markdown', label: 'Markdown' },
];

export interface ExportControlProps {
  projectId: number;
  /** Export just these issues when non-empty. */
  selectedIds: readonly number[];
  /** Applied when nothing is selected, so the export matches what is on screen. */
  filter: Record<string, unknown>;
}

export function ExportControl({
  projectId,
  selectedIds,
  filter,
}: ExportControlProps): JSX.Element {
  const toast = useToast();
  const [format, setFormat] = useState<ExportFormat>('csv');
  const [includeComments, setIncludeComments] = useState(true);

  const run = useMutation<void, { filename: string; blob: Blob }>(
    () =>
      exportApi.run({
        projectId,
        format,
        includeComments,
        // The selection wins when there is one, so the button and the file agree.
        ...(selectedIds.length > 0 ? { issueIds: [...selectedIds] } : { filter }),
      }),
    {
      onSuccess: ({ filename, blob }) => {
        saveFile(filename, blob);
        const scope = selectedIds.length > 0 ? `${selectedIds.length} selected` : 'the current filters';
        toast.success(`Exported ${scope} to ${filename}`);
      },
      onError: (error) => toast.apiError(error),
    },
  );

  return (
    <div className="row" style={{ gap: 'var(--space-2)' }}>
      <label className="checkbox" title="Include each issue's comment history">
        <input
          type="checkbox"
          checked={includeComments}
          onChange={(event) => setIncludeComments(event.target.checked)}
        />
        Comments
      </label>
      <Select
        label="Format"
        value={format}
        onChange={(value) => setFormat(value as ExportFormat)}
        options={FORMATS}
      />
      <Button
        onClick={() => run.mutate(undefined as never)}
        loading={run.isPending}
        title={
          selectedIds.length > 0
            ? `Export the ${selectedIds.length} selected issue(s)`
            : 'Export everything matching the current filters'
        }
      >
        {selectedIds.length > 0 ? `Export ${selectedIds.length}` : 'Export'}
      </Button>
    </div>
  );
}
