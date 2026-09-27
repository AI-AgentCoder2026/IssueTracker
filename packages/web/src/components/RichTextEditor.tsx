import { useCallback, useId, useMemo, useRef, useState } from 'react';
import { cx } from '../lib/format';
import { Button } from './Button';

export interface RichTextEditorProps {
  value: string;
  onChange: (value: string) => void;
  label: string;
  placeholder?: string;
  readOnly?: boolean;
  error?: string | null;
  rows?: number;
  /** Set while a save is in flight so the toolbar can be disabled. */
  busy?: boolean;
  onSave?: () => void;
  saveLabel?: string;
  onCancel?: () => void;
  /** Offered above the editor, e.g. a file picker. */
  accessory?: JSX.Element | null;
}

interface ToolbarAction {
  label: string;
  title: string;
  prefix: string;
  suffix: string;
  block?: boolean;
}

const ACTIONS: ToolbarAction[] = [
  { label: 'B', title: 'Bold', prefix: '**', suffix: '**' },
  { label: 'I', title: 'Italic', prefix: '_', suffix: '_' },
  { label: 'S', title: 'Strikethrough', prefix: '~~', suffix: '~~' },
  { label: 'H', title: 'Heading', prefix: '\n### ', suffix: '\n', block: true },
  { label: '•', title: 'Bullet list', prefix: '\n- ', suffix: '', block: true },
  { label: '1.', title: 'Numbered list', prefix: '\n1. ', suffix: '', block: true },
  { label: '❝', title: 'Quote', prefix: '\n> ', suffix: '', block: true },
  { label: '</>', title: 'Inline code', prefix: '`', suffix: '`' },
  { label: '🔗', title: 'Link', prefix: '[', suffix: '](https://)' },
];

/**
 * Markdown editor with a preview toggle. There is no HTML rendering pipeline in
 * the client, so the preview shows the source as monospaced text rather than
 * pretending to parse Markdown.
 */
export function RichTextEditor({
  value,
  onChange,
  label,
  placeholder,
  readOnly = false,
  error,
  rows = 10,
  busy = false,
  onSave,
  saveLabel = 'Save',
  onCancel,
  accessory,
}: RichTextEditorProps): JSX.Element {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const [showPreview, setShowPreview] = useState(false);
  const id = useId();
  const errorId = `${id}-error`;

  const wrapSelection = useCallback(
    (action: ToolbarAction) => {
      const node = textareaRef.current;
      if (node === null) return;
      const start = node.selectionStart;
      const end = node.selectionEnd;
      const selected = value.slice(start, end);
      const next = `${value.slice(0, start)}${action.prefix}${selected}${action.suffix}${value.slice(end)}`;
      onChange(next);
      window.requestAnimationFrame(() => {
        node.focus();
        const caret = start + action.prefix.length + selected.length;
        node.setSelectionRange(caret, caret);
      });
    },
    [onChange, value],
  );

  const stats = useMemo(() => {
    const words = value.trim() === '' ? 0 : value.trim().split(/\s+/).length;
    return { chars: value.length, words };
  }, [value]);

  return (
    <div className="stack-sm">
      <div className="row-between">
        <label className="field-label" htmlFor={id}>
          {label}
        </label>
        <span className="subtle">
          {stats.words} words · {stats.chars} chars
        </span>
      </div>

      {readOnly ? (
        <div className="rich-preview" style={{ borderRadius: 'var(--radius-sm)' }}>
          {value.trim() === '' ? (
            <span className="subtle">No description yet.</span>
          ) : (
            <pre style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{value}</pre>
          )}
        </div>
      ) : (
        <>
          <div className="rich-toolbar" role="toolbar" aria-label={`${label} formatting`}>
            {ACTIONS.map((action) => (
              <Button
                key={action.title}
                size="sm"
                onClick={() => wrapSelection(action)}
                aria-label={action.title}
                title={action.title}
                disabled={busy}
              >
                {action.label}
              </Button>
            ))}
            <Button
              size="sm"
              onClick={() => setShowPreview((v) => !v)}
              aria-pressed={showPreview}
              disabled={busy}
            >
              {showPreview ? 'Edit' : 'Preview'}
            </Button>
          </div>
          {showPreview ? (
            <div className="rich-preview">
              {value.trim() === '' ? (
                <span className="subtle">Nothing to preview yet.</span>
              ) : (
                <pre style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{value}</pre>
              )}
            </div>
          ) : (
            <textarea
              id={id}
              ref={textareaRef}
              className="textarea rich-editor"
              value={value}
              rows={rows}
              placeholder={placeholder}
              disabled={busy}
              aria-invalid={error !== undefined && error !== null ? true : undefined}
              aria-describedby={error ? errorId : undefined}
              onChange={(event) => onChange(event.target.value)}
            />
          )}
        </>
      )}

      {error !== undefined && error !== null ? (
        <span className={cx('field-error')} id={errorId}>
          {error}
        </span>
      ) : null}

      {accessory ?? null}

      {!readOnly && (onSave !== undefined || onCancel !== undefined) ? (
        <div className="row">
          {onSave !== undefined ? (
            <Button variant="primary" size="sm" onClick={onSave} loading={busy}>
              {saveLabel}
            </Button>
          ) : null}
          {onCancel !== undefined ? (
            <Button size="sm" onClick={onCancel} disabled={busy}>
              Cancel
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
