/**
 * Bulk action bar and editor.
 *
 * Shown once issues are selected in the list. The flow is deliberately two
 * steps: build operations, then *preview* them. The preview endpoint writes
 * nothing and reports, per operation, how many issues would actually change
 * and which would be skipped — so a bulk edit that would quietly do nothing is
 * visible before it is committed rather than after.
 */

import { useMemo, useState } from 'react';
import {
  bulkApi,
  type BulkOperationDraft,
  type BulkPreview,
  type BulkResult,
} from '../api/repo';
import { useMutation, useQuery } from '../api/hooks';
import {
  ISSUE_PRIORITIES,
  ISSUE_STATES,
  ISSUE_TYPES,
  ISSUE_TYPE_LABEL,
  PRIORITY_LABEL,
  type IssueSummary,
  type Label,
  type MemberView,
} from '../api/types';
import { Button } from './Button';
import { Field, Select } from './Select';
import { useToast } from './Toast';

/** One configurable operation, kept flat so the dialog stays declarative. */
interface DraftOp {
  id: string;
  op: BulkOperationDraft;
  label: string;
}

const newOp = (id: string, op: BulkOperationDraft, label: string): DraftOp => ({ id, op, label });

let opCounter = 0;
const nextId = (): string => `op${(opCounter += 1)}`;

export interface BulkEditBarProps {
  selected: readonly IssueSummary[];
  labels: readonly Label[];
  members: readonly MemberView[];
  onClear: () => void;
  onApplied: () => void;
}

export function BulkEditBar({
  selected,
  labels,
  members,
  onClear,
  onApplied,
}: BulkEditBarProps): JSX.Element | null {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [ops, setOps] = useState<DraftOp[]>([]);
  const [result, setResult] = useState<BulkResult | null>(null);

  const issueIds = useMemo(() => selected.map((issue) => issue.id), [selected]);
  const operations = useMemo(() => ops.map((entry) => entry.op), [ops]);
  const ready = issueIds.length > 0 && operations.length > 0;

  const previewQuery = useQuery<BulkPreview>(
    (signal) => bulkApi.preview(issueIds, operations, signal),
    [issueIds.join(','), JSON.stringify(operations)],
    { enabled: open && ready },
  );

  const apply = useMutation<void, BulkResult>(
    () => bulkApi.apply(issueIds, operations),
    {
      onSuccess: (applied) => {
        setResult(applied);
        toast.success(
          applied.failed === 0
            ? `Updated ${applied.succeeded} issue${applied.succeeded === 1 ? '' : 's'}`
            : `Updated ${applied.succeeded}, ${applied.failed} failed`,
        );
        onApplied();
        // The failures matter more than the successes, so the dialog stays open
        // to show them rather than closing as though it all worked.
        if (applied.failed === 0) {
          setOpen(false);
          setOps([]);
          setResult(null);
          onClear();
        }
      },
      onError: (error) => toast.apiError(error),
    },
  );

  if (selected.length === 0) return null;

  const add = (draft: DraftOp): void => setOps((previous) => [...previous, draft]);
  const update = (id: string, patch: Partial<DraftOp>): void =>
    setOps((previous) => previous.map((entry) => (entry.id === id ? { ...entry, ...patch } : entry)));
  const remove = (id: string): void => setOps((previous) => previous.filter((e) => e.id !== id));

  const preview = previewQuery.data;

  return (
    <>
      <div
        className="card card-pad row-between"
        role="region"
        aria-label="Bulk actions"
        style={{ position: 'sticky', bottom: 'var(--space-4)', zIndex: 5 }}
      >
        <span>
          <strong>{selected.length}</strong> issue{selected.length === 1 ? '' : 's'} selected
        </span>
        <div className="row" style={{ gap: 'var(--space-2)' }}>
          <Button
            onClick={() => {
              setOpen(true);
              setResult(null);
            }}
            disabled={!ready}
          >
            Bulk edit
          </Button>
          <Button variant="ghost" onClick={onClear}>
            Clear
          </Button>
        </div>
      </div>

      {open ? (
        <div
          className="modal-backdrop"
          role="dialog"
          aria-modal="true"
          aria-label="Bulk edit"
          onClick={() => setOpen(false)}
        >
          <div className="modal card-pad stack" onClick={(e) => e.stopPropagation()}>
            <header className="row-between">
              <h2>Bulk edit {issueIds.length} issue{issueIds.length === 1 ? '' : 's'}</h2>
              <Button variant="ghost" onClick={() => setOpen(false)}>
                Close
              </Button>
            </header>

            <div className="stack" style={{ gap: 'var(--space-2)' }}>
              <div className="row" style={{ gap: 'var(--space-2)', flexWrap: 'wrap' }}>
                <Select
                  label="Add operation"
                  value=""
                  onChange={(value) => {
                    switch (value) {
                      case 'setState':
                        add(
                          newOp(nextId(), { op: 'setState', state: 'closed' }, 'set state → closed'),
                        );
                        break;
                      case 'setPriority':
                        add(
                          newOp(nextId(), { op: 'setPriority', priority: 'high' }, 'set priority → high'),
                        );
                        break;
                      case 'setType':
                        add(
                          newOp(nextId(), { op: 'setType', type: 'task' }, 'set type → task'),
                        );
                        break;
                      case 'assign':
                        add(
                          newOp(
                            nextId(),
                            { op: 'assign', assigneeId: members[0]?.userId ?? null },
                            `assign → ${members[0]?.user.displayName ?? 'nobody'}`,
                          ),
                        );
                        break;
                      case 'addLabels':
                        if (labels[0] !== undefined) {
                          add(
                            newOp(
                              nextId(),
                              { op: 'addLabels', labelIds: [labels[0].id] },
                              `add label ${labels[0].name}`,
                            ),
                          );
                        }
                        break;
                      case 'archive':
                        add(newOp(nextId(), { op: 'archive', archived: true }, 'archive'));
                        break;
                      default:
                        break;
                    }
                  }}
                  options={[
                    { value: '', label: 'Choose…' },
                    { value: 'setState', label: 'Set state' },
                    { value: 'setPriority', label: 'Set priority' },
                    { value: 'setType', label: 'Set type' },
                    { value: 'assign', label: 'Assign' },
                    { value: 'addLabels', label: 'Add label' },
                    { value: 'archive', label: 'Archive' },
                  ]}
                />
              </div>

              {ops.length === 0 ? (
                <p className="subtle">
                  No operations yet. Add at least one — nothing is written until you confirm.
                </p>
              ) : (
                <ul className="stack" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
                  {ops.map((entry) => (
                    <li key={entry.id} className="row-between">
                      <OperationControls
                        entry={entry}
                        labels={labels}
                        members={members}
                        onChange={(patch) => update(entry.id, patch)}
                      />
                      <Button variant="ghost" onClick={() => remove(entry.id)}>
                        Remove
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            {previewQuery.isLoading ? <p className="subtle">Checking what would change…</p> : null}

            {preview !== null ? (
              <div className="stack" style={{ gap: 4 }}>
                <p className="subtle">
                  {preview.eligible} of {preview.requested} selected issue
                  {preview.requested === 1 ? '' : 's'} can be changed by you.
                </p>
                <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
                  {preview.operations.map((op) => (
                    <li key={op.op} className="row-between">
                      <span>{op.label}</span>
                      <span className="subtle nowrap">
                        {op.wouldChange} would change
                        {op.skipped > 0 ? ` · ${op.skipped} skipped` : ''}
                      </span>
                    </li>
                  ))}
                </ul>
                {preview.operations.every((op) => op.wouldChange === 0) ? (
                  <p className="subtle">
                    Nothing would actually change. Applying now would be a no-op.
                  </p>
                ) : null}
              </div>
            ) : null}

            {result !== null && result.failed > 0 ? (
              <div className="stack" style={{ gap: 4 }}>
                <p>
                  <strong>{result.failed}</strong> issue
                  {result.failed === 1 ? '' : 's'} could not be changed:
                </p>
                <ul>
                  {result.results
                    .filter((row) => !row.ok)
                    .slice(0, 10)
                    .map((row) => (
                      <li key={row.issueId} className="subtle">
                        #{row.issueId}: {row.error}
                      </li>
                    ))}
                </ul>
              </div>
            ) : null}

            <footer className="row" style={{ gap: 'var(--space-2)', justifyContent: 'flex-end' }}>
              <Button variant="ghost" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button
                onClick={() => apply.mutate(undefined as never)}
                disabled={!ready || apply.isPending}
                loading={apply.isPending}
              >
                Apply to {issueIds.length}
              </Button>
            </footer>
          </div>
        </div>
      ) : null}
    </>
  );
}

/** Per-operation value pickers, so the label always describes the real value. */
function OperationControls({
  entry,
  labels,
  members,
  onChange,
}: {
  entry: DraftOp;
  labels: readonly Label[];
  members: readonly MemberView[];
  onChange: (patch: Partial<DraftOp>) => void;
}): JSX.Element {
  const op = entry.op as { op?: string; [key: string]: unknown };

  switch (op.op) {
    case 'setState':
      return (
        <Select
          label="State"
          value={String(op.state ?? '')}
          onChange={(state) => onChange({ op: { op: 'setState', state }, label: `set state → ${state}` })}
          options={ISSUE_STATES.map((state) => ({ value: state, label: state.replace('_', ' ') }))}
        />
      );
    case 'setPriority':
      return (
        <Select
          label="Priority"
          value={String(op.priority ?? '')}
          onChange={(priority) =>
            onChange({ op: { op: 'setPriority', priority }, label: `set priority → ${priority}` })
          }
          options={ISSUE_PRIORITIES.map((priority) => ({
            value: priority,
            label: PRIORITY_LABEL[priority],
          }))}
        />
      );
    case 'setType':
      return (
        <Select
          label="Type"
          value={String(op.type ?? '')}
          onChange={(type) => onChange({ op: { op: 'setType', type }, label: `set type → ${type}` })}
          options={ISSUE_TYPES.map((type) => ({ value: type, label: ISSUE_TYPE_LABEL[type] }))}
        />
      );
    case 'assign':
      return (
        <Select
          label="Assignee"
          value={op.assigneeId === null || op.assigneeId === undefined ? '' : String(op.assigneeId)}
          onChange={(value) => {
            const assigneeId = value === '' ? null : Number(value);
            onChange({
              op: { op: 'assign', assigneeId },
              label: `assign → ${assigneeId === null ? 'nobody' : members.find((m) => m.userId === assigneeId)?.user.displayName ?? 'someone'}`,
            });
          }}
          options={[
            { value: '', label: 'Nobody' },
            ...members.map((member) => ({
              value: String(member.userId),
              label: member.user.displayName,
            })),
          ]}
        />
      );
    case 'addLabels':
      return (
        <Select
          label="Label"
          value={String((op.labelIds as number[] | undefined)?.[0] ?? '')}
          onChange={(value) => {
            const labelIds = [Number(value)];
            const name = labels.find((label) => label.id === labelIds[0])?.name ?? 'label';
            onChange({ op: { op: 'addLabels', labelIds }, label: `add label ${name}` });
          }}
          options={labels.map((label) => ({ value: String(label.id), label: label.name }))}
        />
      );
    case 'archive':
      return (
        <Select
          label="Archive"
          value={op.archived === true ? 'true' : 'false'}
          onChange={(value) =>
            onChange({
              op: { op: 'archive', archived: value === 'true' },
              label: value === 'true' ? 'archive' : 'unarchive',
            })
          }
          options={[
            { value: 'true', label: 'Archive' },
            { value: 'false', label: 'Unarchive' },
          ]}
        />
      );
    default:
      return <span className="subtle">{entry.label}</span>;
  }
}

export { Field };
