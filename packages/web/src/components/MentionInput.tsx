import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useQuery } from '../api/hooks';
import { userApi } from '../api/repo';
import { MENTION_PATTERN, extractMentionUsernames, type PublicUser } from '../api/types';
import { Avatar } from './Avatar';
import { Button } from './Button';

export interface MentionInputProps {
  value: string;
  onChange: (value: string) => void;
  label: string;
  placeholder?: string;
  disabled?: boolean;
  rows?: number;
  onSubmit?: () => void;
  submitLabel?: string;
  busy?: boolean;
  error?: string | null;
  /** Rendered under the control; used for the parsed-mention preview. */
  footer?: JSX.Element | null;
}

interface MentionQuery {
  start: number;
  term: string;
}

/** Finds the `@fragment` the caret currently sits inside, if any. */
function mentionQueryAt(value: string, caret: number): MentionQuery | null {
  const upto = value.slice(0, caret);
  const match = /(^|[^\w`])@([a-zA-Z0-9._-]*)$/.exec(upto);
  if (match === null) return null;
  const term = match[2] ?? '';
  const start = caret - term.length;
  return { start, term };
}

/**
 * Textarea with `@username` autocomplete. The inserted text is the plain
 * `@username` token, which is exactly what `extractMentionUsernames` on the
 * server parses — no extra encoding round trip.
 */
export function MentionInput({
  value,
  onChange,
  label,
  placeholder,
  disabled = false,
  rows = 5,
  onSubmit,
  submitLabel = 'Comment',
  busy = false,
  error,
  footer,
}: MentionInputProps): JSX.Element {
  const id = useId();
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const [query, setQuery] = useState<MentionQuery | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const listboxId = `${id}-suggestions`;

  const term = query?.term ?? '';
  const users = useQuery<PublicUser[]>(
    (signal) => userApi.list({ q: term, limit: 8, signal }),
    [term],
    { enabled: query !== null },
  );

  const candidates = useMemo(
    () => (users.data ?? []).filter((user) => user.username.toLowerCase().startsWith(term.toLowerCase())),
    [users.data, term],
  );

  const close = useCallback(() => {
    setQuery(null);
    setActiveIndex(0);
  }, []);

  const insert = useCallback(
    (user: PublicUser) => {
      if (query === null) return;
      const before = value.slice(0, query.start);
      const after = value.slice(
        query.start + query.term.length,
      );
      const needsSpace = after === '' || after.startsWith(' ');
      const next = `${before}@${user.username}${needsSpace ? ' ' : ''}${after}`;
      onChange(next);
      close();
      window.requestAnimationFrame(() => {
        const node = textareaRef.current;
        if (node === null) return;
        const caret = next.length - after.length;
        node.focus();
        node.setSelectionRange(caret, caret);
      });
    },
    [close, onChange, query, value],
  );

  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>) => {
      if (query !== null && candidates.length > 0) {
        if (event.key === 'ArrowDown') {
          event.preventDefault();
          setActiveIndex((i) => (i + 1) % candidates.length);
          return;
        }
        if (event.key === 'ArrowUp') {
          event.preventDefault();
          setActiveIndex((i) => (i - 1 + candidates.length) % candidates.length);
          return;
        }
        if (event.key === 'Enter' || event.key === 'Tab') {
          const chosen = candidates[activeIndex];
          if (chosen !== undefined) {
            event.preventDefault();
            insert(chosen);
          }
          return;
        }
        if (event.key === 'Escape') {
          event.preventDefault();
          close();
          return;
        }
      }
      if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && onSubmit !== undefined) {
        event.preventDefault();
        onSubmit();
      }
    },
    [activeIndex, candidates, close, insert, onSubmit, query],
  );

  useEffect(() => {
    setActiveIndex(0);
  }, [term]);

  const resolvedMentions = useMemo(
    () =>
      extractMentionUsernames(value)
        .map((username) => (users.data ?? []).find((user) => user.username === username))
        .filter((user): user is PublicUser => user !== undefined),
    [value, users.data],
  );

  return (
    <div className="stack-sm mention-input-wrap">
      <label className="field-label" htmlFor={id}>
        {label}
      </label>
      <textarea
        id={id}
        ref={textareaRef}
        className="textarea"
        rows={rows}
        value={value}
        placeholder={placeholder}
        disabled={disabled || busy}
        aria-invalid={error !== undefined && error !== null ? true : undefined}
        aria-autocomplete="list"
        aria-expanded={query !== null && candidates.length > 0}
        aria-controls={listboxId}
        onChange={(event) => {
          const next = event.target.value;
          onChange(next);
          setQuery(mentionQueryAt(next, event.target.selectionStart ?? next.length));
        }}
        onKeyDown={onKeyDown}
        onBlur={() => window.setTimeout(close, 120)}
        onClick={(event) => setQuery(mentionQueryAt(value, event.currentTarget.selectionStart ?? 0))}
      />

      {query !== null && candidates.length > 0 ? (
        <ul className="mention-suggestions" id={listboxId} role="listbox" aria-label="Mention a teammate">
          {candidates.map((user, index) => (
            <li key={user.id} role="none">
              <button
                type="button"
                role="option"
                aria-selected={index === activeIndex}
                className="mention-suggestion"
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => insert(user)}
              >
                <Avatar name={user.displayName} src={user.avatarUrl} size="sm" />
                <span className="grow truncate">{user.displayName}</span>
                <span className="subtle">@{user.username}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      {error !== undefined && error !== null ? <span className="field-error">{error}</span> : null}

      {resolvedMentions.length > 0 ? (
        <div className="row" style={{ gap: 4 }}>
          <span className="subtle">Notifying:</span>
          {resolvedMentions.map((user) => (
            <span key={user.id} className="row" style={{ gap: 4 }}>
              <Avatar name={user.displayName} src={user.avatarUrl} size="sm" />
              <span className="subtle">@{user.username}</span>
            </span>
          ))}
        </div>
      ) : null}

      {footer ?? null}

      {onSubmit !== undefined ? (
        <div className="row">
          <Button variant="primary" size="sm" onClick={onSubmit} disabled={disabled} loading={busy}>
            {submitLabel}
          </Button>
          <span className="subtle">Tip: type @ to mention someone · ⌘/Ctrl + Enter to submit</span>
        </div>
      ) : null}
    </div>
  );
}

export { MENTION_PATTERN };
