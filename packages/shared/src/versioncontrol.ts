/**
 * Version-control linkage.
 *
 * Issues are linked to the artefacts of the work: the feature branch, the
 * commits on it, the merge request, the deploy tag. Two levels, because they
 * answer different questions:
 *
 *   `Repository`  which repository does this project live in?
 *   `IssueReference`  which artefact belongs to this specific issue?
 *
 * Keeping them separate means an issue can carry several references that are
 * updated independently as the work progresses, rather than a single
 * convention-encoded branch name on the issue row.
 */

import { z } from 'zod';
import type { IsoDateTime, ProjectId, UserId } from './ids.js';

export const VCS_PROVIDERS = ['gitlab', 'github', 'bitbucket', 'generic'] as const;
export type VcsProvider = (typeof VCS_PROVIDERS)[number];

export const REFERENCE_KINDS = [
  'branch',
  'commit',
  'merge_request',
  'pull_request',
  'tag',
  'file',
] as const;
export type ReferenceKind = (typeof REFERENCE_KINDS)[number];

/** Which permission each kind implies, beyond plain `issue.read`. */
export const REFERENCE_KIND_LABEL: Record<ReferenceKind, string> = {
  branch: 'Branch',
  commit: 'Commit',
  merge_request: 'Merge request',
  pull_request: 'Pull request',
  tag: 'Tag',
  file: 'File',
};

export const REFERENCE_STATES = ['open', 'merged', 'closed', 'deployed'] as const;
export type ReferenceState = (typeof REFERENCE_STATES)[number];

/** Kinds that represent completed work rather than something still in flight. */
export const TERMINAL_REFERENCE_STATES: readonly ReferenceState[] = ['merged', 'closed', 'deployed'];

export function isTerminalReferenceState(state: ReferenceState): boolean {
  return TERMINAL_REFERENCE_STATES.includes(state);
}

export interface Repository {
  id: number;
  projectId: ProjectId;
  provider: VcsProvider;
  name: string;
  baseUrl: string;
  externalId: string | null;
  defaultBranch: string;
  /** Set when this repository is the project mirrored by a GitLab connection. */
  gitlabConnectionId: number | null;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

export interface IssueReference {
  id: number;
  issueId: number;
  repositoryId: number;
  kind: ReferenceKind;
  provider: VcsProvider;
  /** Branch name, commit SHA, MR iid or file path, depending on `kind`. */
  ref: string;
  /** Commit SHA for a branch; the MR head SHA for a merge request. */
  headSha: string | null;
  title: string;
  state: ReferenceState;
  url: string | null;
  /** True when a sync inferred this from a naming convention. */
  autoDetected: boolean;
  linkedBy: UserId | null;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

/** A reference joined with the fields the UI needs to render it. */
export interface IssueReferenceView extends IssueReference {
  repositoryName: string;
  repositoryProvider: VcsProvider;
  /** Project key of the owning issue, e.g. `PROJ`. */
  issueKey: string;
  issueTitle: string;
  /** True when the artefact's state counts as finished work. */
  isMerged: boolean;
}

export interface BranchLinkRule {
  id: number;
  projectId: ProjectId;
  repositoryId: number;
  /** Capture group naming the issue key, e.g. `^(?P<key>[A-Z]+-\d+)`. */
  pattern: string;
  /** Prefixes stripped before matching, e.g. `["feature/"]`. */
  stripPrefixes: string[];
  enabled: boolean;
  lastImportedAt: IsoDateTime | null;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export const createRepositorySchema = z.object({
  provider: z.enum(VCS_PROVIDERS).default('gitlab'),
  name: z.string().trim().min(1).max(300),
  // Only https (or localhost) so a generated link cannot be `javascript:`.
  baseUrl: z
    .string()
    .trim()
    .max(500)
    .default('')
    .refine(
      (value) =>
        value === '' ||
        value.startsWith('https://') ||
        /^http:\/\/(localhost|127\.0\.0\.1)/.test(value),
      { message: 'must be an absolute https URL, or empty' },
    ),
  externalId: z.string().trim().max(200).nullable().default(null),
  defaultBranch: z.string().trim().min(1).max(200).default('main'),
});

export type CreateRepositoryInput = z.infer<typeof createRepositorySchema>;

export const createReferenceSchema = z.object({
  repositoryId: z.number().int().positive(),
  kind: z.enum(REFERENCE_KINDS),
  /** Branch name, commit SHA, MR iid or file path. */
  ref: z
    .string()
    .trim()
    .min(1)
    .max(400)
    .refine((value) => !value.startsWith('-'), 'a ref cannot begin with a dash'),
  headSha: z
    .string()
    .trim()
    .max(64)
    .regex(/^[0-9a-fA-F]*$/, 'a SHA is hexadecimal')
    .nullable()
    .default(null),
  title: z.string().trim().max(500).default(''),
  state: z.enum(REFERENCE_STATES).default('open'),
  // Only http(s), so a stored link cannot smuggle a `javascript:` scheme into
  // the UI as an anchor href.
  url: z
    .string()
    .trim()
    .max(1000)
    .nullable()
    .default(null)
    .refine(
      (value) =>
        value === null ||
        value === '' ||
        value.startsWith('https://') ||
        value.startsWith('http://'),
      { message: 'must be an http(s) URL' },
    ),
});

export type CreateReferenceInput = z.infer<typeof createReferenceSchema>;
export type UpdateReferenceInput = z.infer<typeof updateReferenceSchema>;

export const updateReferenceSchema = z.object({
  title: z.string().trim().max(500).optional(),
  state: z.enum(REFERENCE_STATES).optional(),
  headSha: z.string().trim().max(64).nullable().optional(),
  url: z.string().trim().max(1000).nullable().optional(),
});

export const createBranchLinkRuleSchema = z.object({
  repositoryId: z.number().int().positive(),
  // A named capture group is required, because that is what names the issue.
  pattern: z
    .string()
    .trim()
    .min(3)
    .max(200)
    .refine((value) => /\(\?<[A-Za-z_][A-Za-z0-9_]*>/.test(value), {
      // JavaScript spells a named group `(?<name>…)`. `(?P<name>…)` is Python
      // syntax and throws "Invalid group" at RegExp construction time.
      message: 'pattern must contain a named capture group, e.g. (?<key>[A-Z]+-\\d+)',
    })
    .refine(
      (value) => {
        try {
          // Reject an uncompilable regex at the edge rather than mid-sync.
          new RegExp(value);
          return true;
        } catch {
          return false;
        }
      },
      { message: 'pattern must be a valid regular expression' },
    ),
  stripPrefixes: z.array(z.string().trim().max(100)).max(20).default([]),
  enabled: z.boolean().default(true),
});

export type CreateBranchLinkRuleInput = z.infer<typeof createBranchLinkRuleSchema>;

/** Result of one branch-import pass over a repository. */
export interface BranchImportResult {
  scanned: number;
  linked: number;
  updated: number;
  /** Issues named by a branch that does not exist locally. */
  unresolved: Array<{ branch: string; issueKey: string }>;
  /** Malformed names the rules could not interpret; surfaced, not swallowed. */
  skipped: Array<{ branch: string; reason: string }>;
}

/** Aggregate linkage facts shown in the issue header. */
export interface IssueLinkageSummary {
  issueId: number;
  branches: number;
  commits: number;
  mergeRequests: number;
  /** References whose state counts as finished work. */
  merged: number;
  /** The most recently updated reference, for a quick link. */
  latest: Pick<IssueReference, 'id' | 'kind' | 'ref' | 'url'> | null;
}

/**
 * Derive an issue key from a branch name using a rule.
 *
 * Exported separately from the service so the parsing is unit-testable without
 * a database, and so the GitLab sync can reuse it.
 */
export function parseIssueKeyFromRef(
  ref: string,
  rule: { pattern: string; stripPrefixes: readonly string[] },
): string | null {
  let candidate = ref.trim();
  for (const prefix of rule.stripPrefixes) {
    if (prefix.length > 0 && candidate.toLowerCase().startsWith(prefix.toLowerCase())) {
      candidate = candidate.slice(prefix.length);
      break;
    }
  }

  let pattern: RegExp;
  try {
    pattern = new RegExp(rule.pattern);
  } catch {
    return null;
  }

  const match = pattern.exec(candidate);
  if (!match) return null;

  // Prefer a group literally named `key`, then the first defined group.
  if (match.groups?.['key']) return match.groups['key'];
  for (const group of match.slice(1)) {
    if (group) return group;
  }
  return null;
}

/** Default rule for a project whose key is `PROJ`. */
export function defaultBranchRuleFor(projectKey: string): {
  pattern: string;
  stripPrefixes: string[];
} {
  // Escape the project key so a key containing regex metacharacters cannot
  // produce a rule that matches the wrong issues.
  const escaped = projectKey.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // `(?<key>…)` is the JavaScript spelling of a named group.
  return {
    pattern: `^(?<key>${escaped}-\\d+)`,
    stripPrefixes: ['feature/', 'bugfix/', 'hotfix/', 'chore/', 'release/'],
  };
}
