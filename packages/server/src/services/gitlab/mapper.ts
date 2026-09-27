/**
 * Pure mapping between the GitLab REST v4 payloads and the local issue model.
 *
 * Nothing in this module performs I/O, touches the database or reads the clock,
 * so every function is deterministic given its arguments and can be round-trip
 * tested in isolation.
 *
 * Priority convention
 * -------------------
 * GitLab has no native priority field. The local `IssuePriority` is therefore
 * encoded as a reserved label `priority::<name>` (e.g. `priority::high`). The
 * label is written on push and stripped from the visible label list on import,
 * so it never shows up as a user-facing label. The same trick is used for the
 * issue type when `syncIncidents` is on (`type::incident`).
 *
 * Title convention
 * ----------------
 * When a connection declares a `titlePrefix`, it belongs to the **GitLab**
 * side: the prefix is added on push and removed again on import, so a local
 * issue always carries the human title the user typed and a push/pull cycle
 * lands the exact same title on GitLab. Applying the prefix in both places
 * would make the title oscillate.
 */

import {
  canonicalJson,
  type GitLabConnection,
  type GitLabIssuePayload,
  type Issue,
  type IssuePriority,
  type IssueState,
  type IssueType,
} from '@tracker/shared';
import { sha256Hex } from '../../lib/crypto.ts';

// ---------------------------------------------------------------------------
// Reserved label conventions
// ---------------------------------------------------------------------------

/** Prefix of the synthetic label carrying the local priority. */
export const PRIORITY_LABEL_PREFIX = 'priority::';
/** Prefix of the synthetic label carrying the local issue type. */
export const TYPE_LABEL_PREFIX = 'type::';
/** All label prefixes the adapter owns; they are never surfaced as labels. */
export const INTERNAL_LABEL_PREFIXES: readonly string[] = [
  PRIORITY_LABEL_PREFIX,
  TYPE_LABEL_PREFIX,
];

/** HTML comment appended to a pushed note so it can be recognised on import. */
const NOTE_MARKER_PREFIX = '<!-- tracker:';
const NOTE_MARKER_SUFFIX = ' -->';

/** The set of issue priorities a `priority::` label may carry. */
const ISSUE_PRIORITIES: readonly IssuePriority[] = [
  'lowest',
  'low',
  'medium',
  'high',
  'highest',
  'critical',
];
const ISSUE_TYPES: readonly IssueType[] = [
  'bug',
  'feature',
  'task',
  'incident',
  'chore',
  'question',
];

/** Minimal workflow status shape the mapper needs; avoids importing services. */
export type StatusByKeyEntry = {
  id: number;
  key: string;
  state: IssueState;
  isClosed: boolean;
  position: number;
};

export type StatusByKey = ReadonlyMap<string, StatusByKeyEntry>;

// ---------------------------------------------------------------------------
// Small string / date helpers
// ---------------------------------------------------------------------------

function isInternalLabel(label: string): boolean {
  const lower = label.toLowerCase();
  return INTERNAL_LABEL_PREFIXES.some((prefix) => lower.startsWith(prefix));
}

function afterPrefix(value: string, prefix: string): string {
  return value.slice(prefix.length);
}

/** Prefix a title, collapsing whitespace so the result is still tidy. */
export function applyTitlePrefix(title: string, titlePrefix: string): string {
  if (!titlePrefix) return title;
  return `${titlePrefix.trim()} ${title}`.trim();
}

/**
 * Remove a previously applied prefix. A prefix is only stripped when it is
 * actually there, so a GitLab issue created by a human (no prefix) keeps its
 * title untouched.
 */
export function stripTitlePrefix(title: string, titlePrefix: string): string {
  const prefix = titlePrefix.trim();
  if (!prefix) return title;
  return title.startsWith(`${prefix} `) ? title.slice(prefix.length + 1) : title;
}

/** Normalise a due date to GitLab's `YYYY-MM-DD` (or null). */
export function toGitLabDueDate(value: string | null): string | null {
  if (!value) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString().slice(0, 10);
}

/** Normalise a GitLab `YYYY-MM-DD` into the local ISO timestamp convention. */
export function fromGitLabDueDate(value: string | null): string | null {
  if (!value) return null;
  const match = /^(\d{4}-\d{2}-\d{2})$/.exec(value.trim());
  if (match?.[1]) return `${match[1]}T00:00:00.000Z`;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/** Preferred workflow key for each GitLab state, best first. */
const OPEN_STATE_KEYS: readonly string[] = ['open', 'backlog'];
const CLOSED_STATE_KEYS: readonly string[] = ['closed'];

/**
 * Map a GitLab issue state onto a local `IssueState` using the project's
 * workflow. GitLab only distinguishes open from closed, so an open issue lands
 * on the project's unstarted column and a closed one on a closed column.
 */
export function mapGitLabStateToLocalState(
  gitlabState: 'opened' | 'closed',
  statusByKey: StatusByKey = new Map(),
): IssueState {
  const preferred = gitlabState === 'opened' ? OPEN_STATE_KEYS : CLOSED_STATE_KEYS;
  for (const key of preferred) {
    const found = statusByKey.get(key);
    if (found) return found.state;
  }
  for (const entry of statusByKey.values()) {
    if (gitlabState === 'opened' && entry.state === 'open') return entry.state;
    if (gitlabState === 'closed' && entry.isClosed) return entry.state;
  }
  return gitlabState === 'opened' ? 'open' : 'closed';
}

/** Best status id for a local state, preferring a key of the same name. */
export function resolveStatusIdForState(
  state: IssueState,
  statusByKey: StatusByKey,
): number | null {
  const direct = statusByKey.get(state);
  if (direct) return direct.id;
  for (const entry of statusByKey.values()) {
    if (entry.state === state) return entry.id;
  }
  return null;
}

/**
 * GitLab expresses a state change as an event, not a state. Terminal local
 * states close the GitLab issue; everything else reopens it. `resolved` stays
 * open on purpose: GitLab has no "resolved" concept, so the resolution is kept
 * in the local workflow only.
 */
export function mapLocalStateToGitLabState(
  state: IssueState,
): 'opened' | 'closed' {
  return state === 'closed' || state === 'wont_fix' || state === 'duplicate'
    ? 'closed'
    : 'opened';
}

/** The write verb matching {@link mapLocalStateToGitLabState}. */
export function mapLocalStateToStateEvent(
  state: IssueState,
): 'close' | 'reopen' {
  return mapLocalStateToGitLabState(state) === 'closed' ? 'close' : 'reopen';
}

// ---------------------------------------------------------------------------
// Priority / type labels
// ---------------------------------------------------------------------------

/** Encode a local priority as the reserved GitLab label. */
export function mapPriorityToGitlab(priority: IssuePriority): string {
  return `${PRIORITY_LABEL_PREFIX}${priority}`;
}

/** True when the label is one of our internal markers. */
export function isPriorityLabel(label: string): boolean {
  return label.toLowerCase().startsWith(PRIORITY_LABEL_PREFIX);
}

/** True when the label is one of our internal markers. */
export function isTypeLabel(label: string): boolean {
  return label.toLowerCase().startsWith(TYPE_LABEL_PREFIX);
}

export interface DecodedLabels {
  /** Priority encoded in the labels, when present and valid. */
  priority: IssuePriority | null;
  /** Issue type encoded in the labels, when present and valid. */
  type: IssueType | null;
  /** Labels a user should actually see, with the markers removed. */
  visible: string[];
}

/**
 * Split a GitLab label list into the internal markers and the visible labels.
 * Unknown `priority::` values are dropped rather than guessed at, so a typo
 * cannot corrupt a local issue.
 */
export function decodeGitlabLabels(labels: readonly string[]): DecodedLabels {
  let priority: IssuePriority | null = null;
  let type: IssueType | null = null;
  const visible: string[] = [];

  for (const raw of labels) {
    const label = raw.trim();
    if (!label) continue;
    const lower = label.toLowerCase();

    if (lower.startsWith(PRIORITY_LABEL_PREFIX)) {
      const candidate = afterPrefix(lower, PRIORITY_LABEL_PREFIX);
      if (ISSUE_PRIORITIES.includes(candidate as IssuePriority)) {
        priority = candidate as IssuePriority;
      }
      continue;
    }
    if (lower.startsWith(TYPE_LABEL_PREFIX)) {
      const candidate = afterPrefix(lower, TYPE_LABEL_PREFIX);
      if (ISSUE_TYPES.includes(candidate as IssueType)) {
        type = candidate as IssueType;
      }
      continue;
    }
    visible.push(label);
  }

  return { priority, type, visible };
}

/** Encode a local type as the reserved label (used when `syncIncidents` is on). */
export function mapTypeToGitlab(type: IssueType): string {
  return `${TYPE_LABEL_PREFIX}${type}`;
}

/** Priority of a single label, or null. Symmetric with {@link mapPriorityToGitlab}. */
export function priorityFromGitlab(label: string): IssuePriority | null {
  const lower = label.trim().toLowerCase();
  if (!lower.startsWith(PRIORITY_LABEL_PREFIX)) return null;
  const candidate = afterPrefix(lower, PRIORITY_LABEL_PREFIX);
  return ISSUE_PRIORITIES.includes(candidate as IssuePriority)
    ? (candidate as IssuePriority)
    : null;
}

/** Type of a single label, or null. Symmetric with {@link mapTypeToGitlab}. */
export function typeFromGitlab(label: string): IssueType | null {
  const lower = label.trim().toLowerCase();
  if (!lower.startsWith(TYPE_LABEL_PREFIX)) return null;
  const candidate = afterPrefix(lower, TYPE_LABEL_PREFIX);
  return ISSUE_TYPES.includes(candidate as IssueType) ? (candidate as IssueType) : null;
}

// ---------------------------------------------------------------------------
// Content hash
// ---------------------------------------------------------------------------

/**
 * Stable SHA-256 over the mapped fields. Stored in
 * `gitlab_external_links.last_pushed_hash` so a push that would not change
 * anything on GitLab is skipped instead of bumping `updated_at` and creating a
 * phantom change on the next sync.
 */
export function contentHash(payload: Record<string, unknown>): string {
  return sha256Hex(canonicalJson(payload));
}

// ---------------------------------------------------------------------------
// Label mapping
// ---------------------------------------------------------------------------

export interface LocalLabelRef {
  id?: number;
  name: string;
  slug?: string;
}

export interface LabelMapping {
  /** GitLab labels that already exist locally, case-insensitively. */
  matched: Array<{ gitlab: string; local: LocalLabelRef }>;
  /** GitLab labels with no local counterpart; the caller creates them. */
  toCreateLocal: string[];
  /** Internal marker labels that must not become local labels. */
  toStrip: string[];
}

/**
 * Case-insensitive label matching between GitLab and the local project.
 * Matching on name and slug both ways means `Bug` and `bug` are the same label
 * and a sync cannot create endless near-duplicate labels.
 */
export function resolveLabelMapping(
  gitlabLabels: readonly string[],
  localLabels: readonly LocalLabelRef[],
): LabelMapping {
  const index = new Map<string, LocalLabelRef>();
  for (const label of localLabels) {
    const name = label.name.trim().toLowerCase();
    if (name && !index.has(name)) index.set(name, label);
    const slug = label.slug?.trim().toLowerCase();
    if (slug && !index.has(slug)) index.set(slug, label);
  }

  const matched: LabelMapping['matched'] = [];
  const toCreateLocal: string[] = [];
  const toStrip: string[] = [];

  for (const raw of gitlabLabels) {
    const label = raw.trim();
    if (!label) continue;
    if (isInternalLabel(label)) {
      toStrip.push(label);
      continue;
    }
    const found = index.get(label.toLowerCase());
    if (found) matched.push({ gitlab: label, local: found });
    else if (!toCreateLocal.some((existing) => existing.toLowerCase() === label.toLowerCase())) {
      toCreateLocal.push(label);
    }
  }

  return { matched, toCreateLocal, toStrip };
}

/** Local slug for a label name; mirrors the convention used by the label API. */
export function labelSlug(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

// ---------------------------------------------------------------------------
// Issue mapping
// ---------------------------------------------------------------------------

export interface GitLabConnectionSettings {
  syncMode: GitLabConnection['syncMode'];
  titlePrefix: string;
  syncIncidents: boolean;
}
export interface LocalIssueDefaults {
  projectId: number;
  type: IssueType;
  priority: IssuePriority;
  statusId: number;
  reporterId: number | null;
  /** Optional workflow lookup; without it the built-in keys are assumed. */
  statusByKey?: StatusByKey;
}

/** A local issue shaped for mapping: the subset of `Issue` the adapter uses. */
export type LocalIssueLike = Pick<
  Issue,
  'key' | 'title' | 'description' | 'state' | 'priority' | 'type' | 'dueDate'
> & {
  labelNames?: string[];
  assigneeUsername?: string | null;
};

export interface MappedIssue {
  title: string;
  description: string;
  state: IssueState;
  statusId: number;
  priority: IssuePriority;
  type: IssueType;
  /** Visible labels only; internal markers are already removed. */
  labelNames: string[];
  dueDate: string | null;
  assigneeUsername: string | null;
  /** Hash of the mapped content; compare against `last_pushed_hash`. */
  contentHash: string;
}

/**
 * GitLab issue → local issue. The title prefix is removed (it belongs to the
 * GitLab side), the reserved labels are decoded and the due date is
 * normalised; the returned `contentHash` covers every field that participates
 * in conflict detection.
 */
export function gitlabIssueToLocal(
  gitlab: GitLabIssuePayload,
  connection: GitLabConnectionSettings,
  localDefaults: LocalIssueDefaults,
): MappedIssue {
  const labels = decodeGitlabLabels(gitlab.labels ?? []);
  const state = mapGitLabStateToLocalState(
    gitlab.state === 'closed' ? 'closed' : 'opened',
    localDefaults.statusByKey ?? new Map(),
  );
  const statusId =
    resolveStatusIdForState(state, localDefaults.statusByKey ?? new Map()) ??
    localDefaults.statusId;

  const mapped: Omit<MappedIssue, 'contentHash'> = {
    // The prefix lives on GitLab, so the local title is the bare human title.
    title: stripTitlePrefix(gitlab.title ?? '', connection.titlePrefix),
    description: gitlab.description ?? '',
    state,
    statusId,
    priority: labels.priority ?? localDefaults.priority,
    type: labels.type ?? localDefaults.type,
    labelNames: labels.visible,
    dueDate: fromGitLabDueDate(gitlab.due_date ?? null),
    assigneeUsername: gitlab.assignees?.[0]?.username ?? null,
  };

  return { ...mapped, contentHash: contentHash(hashable(mapped)) };
}

export interface GitLabPushOptions {
  titlePrefix: string;
  syncComments: boolean;
  syncIncidents: boolean;
  /** Mirror user labels both ways. Defaults to true. */
  syncLabels?: boolean;
  /** Assignee to write; omitted when unknown, never guessed from the author. */
  assigneeId?: number | null;
}

/**
 * The subset of the GitLab create/update issue API the adapter writes. Local
 * bookkeeping fields (key, sequence, position, estimates, time spent, reporter)
 * are deliberately absent: they have no GitLab equivalent and pushing them
 * would invent data on the remote side.
 */
export interface GitLabIssueWrite {
  title: string;
  description: string;
  state_event: 'close' | 'reopen';
  labels: string;
  due_date: string | null;
  assignee_id?: number;
}

/** Canonical, order-independent view of a mapped issue used for hashing. */
export function hashable(mapped: {
  title: string;
  description: string;
  state: IssueState;
  priority: IssuePriority;
  type: IssueType;
  labelNames: string[];
  dueDate: string | null;
  assigneeUsername: string | null;
}): Record<string, unknown> {
  return {
    title: mapped.title,
    description: mapped.description,
    state: mapped.state,
    priority: mapped.priority,
    type: mapped.type,
    labels: [...mapped.labelNames].map((l) => l.toLowerCase()).sort(),
    dueDate: toGitLabDueDate(mapped.dueDate),
    assignee: mapped.assigneeUsername ?? null,
  };
}

/**
 * Local issue → GitLab write payload. The priority label is always written (it
 * is the only place GitLab can carry a priority); user labels only when
 * `syncLabels` is on; the type label only when `syncIncidents` is on.
 */
export function localIssueToGitlabPayload(
  issue: LocalIssueLike,
  options: GitLabPushOptions,
): GitLabIssueWrite {
  const labels: string[] = [mapPriorityToGitlab(issue.priority)];
  if (options.syncIncidents) {
    labels.push(mapTypeToGitlab(issue.type ?? 'task'));
  }
  if (options.syncLabels !== false) {
    for (const name of issue.labelNames ?? []) {
      const label = name.trim();
      if (!label || isInternalLabel(label)) continue;
      if (!labels.some((existing) => existing.toLowerCase() === label.toLowerCase())) {
        labels.push(label);
      }
    }
  }

  const payload: GitLabIssueWrite = {
    title: applyTitlePrefix(issue.title, options.titlePrefix),
    description: issue.description ?? '',
    state_event: mapLocalStateToStateEvent(issue.state),
    labels: labels.join(','),
    due_date: toGitLabDueDate(issue.dueDate),
  };

  if (options.assigneeId !== undefined && options.assigneeId !== null) {
    payload.assignee_id = options.assigneeId;
  }

  return payload;
}

// ---------------------------------------------------------------------------
// Comment / note round trip
// ---------------------------------------------------------------------------

/**
 * Marker appended to every note pushed from the tracker. On import a note
 * carrying the marker is recognised as our own echo and skipped, which is what
 * stops a comment from bouncing back and forth forever.
 */
export function noteMarker(issueKey: string): string {
  return `${NOTE_MARKER_PREFIX}${issueKey}${NOTE_MARKER_SUFFIX}`;
}

/** Body to push to GitLab: the comment plus its provenance marker. */
export function buildNoteBody(body: string, issueKey: string): string {
  return `${body.trimEnd()}\n\n${noteMarker(issueKey)}`;
}

/** True when a note was pushed by this tracker for `issueKey`. */
export function hasNoteMarker(body: string, issueKey?: string): boolean {
  const index = body.indexOf(NOTE_MARKER_PREFIX);
  if (index < 0) return false;
  if (issueKey === undefined) return body.includes(NOTE_MARKER_SUFFIX, index);
  return body.includes(noteMarker(issueKey));
}

/** Remove the marker so the imported comment reads exactly as it was written. */
export function stripNoteMarker(body: string): string {
  const index = body.indexOf(NOTE_MARKER_PREFIX);
  if (index < 0) return body;
  const end = body.indexOf(NOTE_MARKER_SUFFIX, index);
  if (end < 0) return body;
  return `${body.slice(0, index).trimEnd()}\n\n${body.slice(end + NOTE_MARKER_SUFFIX.length)}`.trim();
}

/** Slack-style cross reference appended to a pulled issue title. */
export function referenceNote(issueKey: string, title: string): string {
  return `${title} (${issueKey})`;
}
