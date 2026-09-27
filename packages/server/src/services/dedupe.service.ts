/**
 * Duplicate detection.
 *
 * IMPORTANT — what this is and is not
 * ------------------------------------
 * No external AI service is available, so "AI-driven duplicate detection" is
 * implemented here as a **deterministic, local similarity engine**. It is fully
 * reproducible, needs no network, and costs nothing to run, but it is *lexical*:
 * it compares normalised titles, token bigrams, trigrams and a hashed
 * bag-of-words vector. It does **not** understand meaning, so two issues that
 * describe the same problem in different words will not be matched.
 *
 * `SemanticStrategy` is named for the role it plays, not for its capabilities: it
 * is feature hashing into 128 dimensions followed by a cosine similarity, which
 * is a lexical proxy, **not** a neural embedding. A real encoder can replace it
 * by implementing {@link SimilarityStrategy} with the same `id` and `score()`
 * signature and registering it in {@link defaultStrategies}; nothing else in this
 * file needs to change.
 *
 * Cost control
 * ------------
 * Comparing every pair is O(n²). Above {@link BUCKET_THRESHOLD} candidates the
 * scan buckets by normalised-title prefix and by shared label, and only compares
 * issues that land in a common bucket, which keeps the comparison count
 * proportional to the duplicated clusters rather than to n².
 */

import type { Actor, DedupeScanInput, DedupeStrategy, DuplicateCandidate } from '@tracker/shared';
import { asIssueId, dedupeScanSchema } from '@tracker/shared';
import { inClause, type Database } from '../db/connection.ts';
import { notFound } from '../errors.ts';
import { sha256Hex } from '../lib/crypto.ts';
import { nowIso } from '../lib/time.ts';
import type { RequestContext, Services } from './context.ts';

/** The subset of an issue a strategy is allowed to look at. */
export interface DedupeComparable {
  id: number;
  key: string;
  title: string;
  type: string;
  labelIds: number[];
}

/** A pluggable scoring function. Replacing one must not change the contract. */
export interface SimilarityStrategy {
  id: DedupeStrategy;
  /** Similarity in 0..1 plus the tokens that explain the score. */
  score(a: DedupeComparable, b: DedupeComparable): { score: number; sharedTokens: string[] };
}

/** Candidate count above which the scan switches to bucketed comparison. */
export const BUCKET_THRESHOLD = 2000;

/** How many leading characters of a normalised title form a bucket key. */
const BUCKET_PREFIX_LENGTH = 8;

type Row = {
  id: number;
  key: string;
  title: string;
  type: string;
  project_id: number;
  state: string;
  label_ids: string;
};

type CandidateRow = Row & { labelIds: number[] };

// ---------------------------------------------------------------------------
// Title normalisation
// ---------------------------------------------------------------------------

/**
 * Reduce a title to a comparable form: case-folded, punctuation stripped,
 * whitespace collapsed, with a leading `[type]` marker and a trailing issue key
 * such as `(PROJ-12)` removed. Two tickets that differ only by those decorations
 * normalise to the same string.
 */
export function normaliseTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/\[[^\]]{1,20}\]\s*/g, ' ')
    .replace(/\(\s*[a-z][a-z0-9]{0,9}-\d+\s*\)/g, ' ')
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenise(normalised: string): string[] {
  return normalised === '' ? [] : normalised.split(' ');
}

/** Character trigrams over a space-padded string, for the Dice coefficient. */
function trigrams(text: string): Set<string> {
  const padded = `  ${text} `;
  const out = new Set<string>();
  for (let index = 0; index + 3 <= padded.length; index += 1) {
    out.add(padded.slice(index, index + 3));
  }
  return out;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const value of a) if (b.has(value)) intersection += 1;
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

function dice(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const value of a) if (b.has(value)) intersection += 1;
  return (2 * intersection) / (a.size + b.size);
}

// ---------------------------------------------------------------------------
// Strategies
// ---------------------------------------------------------------------------

/** Normalised titles are byte-identical. */
export const exactTitleStrategy: SimilarityStrategy = {
  id: 'exact_title',
  score(a, b) {
    const left = normaliseTitle(a.title);
    const right = normaliseTitle(b.title);
    if (left === '' || right === '') return { score: 0, sharedTokens: [] };
    if (left === right) {
      return { score: 1, sharedTokens: tokenise(left) };
    }
    return { score: 0, sharedTokens: intersect(tokenise(left), tokenise(right)) };
  },
};

/**
 * `0.5 * jaccard(token bigrams) + 0.5 * dice(trigrams)`, with a small boost when
 * the two issues share a type or a label. Lexical only — it rewards repeated
 * wording, not shared intent.
 */
export const fuzzyTitleStrategy: SimilarityStrategy = {
  id: 'fuzzy_title',
  score(a, b) {
    const left = normaliseTitle(a.title);
    const right = normaliseTitle(b.title);
    if (left === '' || right === '') return { score: 0, sharedTokens: [] };

    const jaccardScore = jaccard(bigrams(left), bigrams(right));
    const diceScore = dice(trigrams(left), trigrams(right));
    let score = 0.5 * jaccardScore + 0.5 * diceScore;

    if (a.type !== '' && a.type === b.type) score = Math.min(1, score + 0.02);
    if (a.labelIds.some((label) => b.labelIds.includes(label))) {
      score = Math.min(1, score + 0.03);
    }
    return { score, sharedTokens: topSharedTokens(left, right) };
  },
};

/**
 * Feature hashing into 128 dimensions, then cosine similarity.
 *
 * This is a **lexical stand-in for a sentence embedding, not one**. Hashing the
 * same token to the same dimension makes identical vocabulary look similar; it
 * cannot tell that "cannot log in" and "login is broken" mean the same thing. The
 * interface is the point: a real encoder (an embedding model over HTTP, or a
 * local ONNX model) implements {@link SimilarityStrategy} with an `id` of
 * `semantic` and replaces this object in {@link defaultStrategies}, and every
 * caller — `scan`, `suggestForIssue`, the review queue — keeps working unchanged.
 */
export const semanticStrategy: SimilarityStrategy = {
  id: 'semantic',
  score(a, b) {
    const left = hashVector(normaliseTitle(a.title));
    const right = hashVector(normaliseTitle(b.title));
    let dot = 0;
    let leftNorm = 0;
    let rightNorm = 0;
    for (let index = 0; index < left.length; index += 1) {
      const l = left[index] ?? 0;
      const r = right[index] ?? 0;
      dot += l * r;
      leftNorm += l * l;
      rightNorm += r * r;
    }
    if (leftNorm === 0 || rightNorm === 0) return { score: 0, sharedTokens: [] };
    return {
      score: dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm)),
      sharedTokens: topSharedTokens(normaliseTitle(a.title), normaliseTitle(b.title)),
    };
  },
};

const DIMENSIONS = 128;

function hashVector(text: string): number[] {
  const vector = new Array<number>(DIMENSIONS).fill(0);
  for (const token of tokenise(text)) {
    // A stable digest keeps the vector identical across processes, so scores
    // are reproducible between a scan and a later re-scan.
    const digest = sha256Hex(token);
    const bucket = Number.parseInt(digest.slice(0, 4), 16) % DIMENSIONS;
    const sign = Number.parseInt(digest[4] ?? '0', 16) % 2 === 0 ? 1 : -1;
    vector[bucket] = (vector[bucket] ?? 0) + sign;
  }
  return vector;
}

/** Every strategy keyed by its contract id. */
export function defaultStrategies(): Map<DedupeStrategy, SimilarityStrategy> {
  return new Map<DedupeStrategy, SimilarityStrategy>([
    ['exact_title', exactTitleStrategy],
    ['fuzzy_title', fuzzyTitleStrategy],
    ['semantic', semanticStrategy],
  ]);
}

function bigrams(text: string): Set<string> {
  const tokens = tokenise(text);
  if (tokens.length === 0) return new Set();
  if (tokens.length === 1) return new Set(tokens);
  const out = new Set<string>();
  for (let index = 0; index + 1 < tokens.length; index += 1) {
    out.add(`${tokens[index]} ${tokens[index + 1]}`);
  }
  return out;
}

function intersect(a: string[], b: string[]): string[] {
  const set = new Set(b);
  return a.filter((value) => set.has(value));
}

/** The tokens both titles share, most significant first, capped for display. */
function topSharedTokens(left: string, right: string): string[] {
  const shared = intersect(tokenise(left), tokenise(right));
  return shared.slice(0, 8);
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class DedupeService {
  private readonly services: Services;

  constructor(services: Services) {
    // Collaborators are reached through the registry rather than captured as
    // constructor fields, matching the two-phase construction in context.ts.
    this.services = services;
  }

  private get db(): Database {
    return this.services.db;
  }

  // -------------------------------------------------------------------------
  // Scanning
  // -------------------------------------------------------------------------

  /**
   * Compare candidate issues and return the pairs that look like duplicates,
   * strongest first. With `autoLink` set, each accepted pair is persisted as an
   * `is_duplicated_by` link and both issues get a timeline event; otherwise the
   * pairs are returned for human review and nothing is written beyond the audit
   * entry.
   */
  async scan(
    input: DedupeScanInput,
    actor: Actor,
    ctx: RequestContext,
  ): Promise<DuplicateCandidate[]> {
    const parsed = dedupeScanSchema.parse(input);
    const strategies = this.selectStrategies(parsed.strategies);
    const rows = this.loadCandidates(parsed);
    const pairs = this.compare(rows, strategies, parsed.minConfidence);

    const candidates = pairs.slice(0, parsed.limit);
    if (parsed.autoLink) {
      for (const candidate of candidates) {
        this.link(candidate, actor, ctx);
      }
    } else {
      this.services.audit.record(
        {
          action: 'issue.updated',
          entityType: 'dedupe_scan',
          entityId: ctx.requestId,
          projectId: parsed.projectId ?? null,
          after: {
            compared: rows.length,
            candidates: candidates.length,
            minConfidence: parsed.minConfidence,
            strategies: parsed.strategies,
          },
          actorId: Number(actor.userId),
        },
        ctx.auditContext,
      );
    }
    return candidates;
  }

  /**
   * Possible duplicates for one issue, for the issue detail page. The issue
   * itself and anything already linked to it are excluded.
   */
  async suggestForIssue(issueId: number, limit = 10): Promise<DuplicateCandidate[]> {
    const issue = this.db.get<Row>(
      `SELECT id, key, title, type, project_id, state, '' AS label_ids FROM issues WHERE id = ?`,
      [issueId],
    );
    if (!issue) throw notFound('Issue', issueId);
    const source = this.toComparable(issue, this.labelIdsFor([issue.id]).get(issue.id) ?? []);

    const rows = this.db.all<Row>(
      `SELECT i.id, i.key, i.title, i.type, i.project_id, i.state,
              COALESCE(il.label_ids, '') AS label_ids
         FROM issues i
         LEFT JOIN (SELECT issue_id, group_concat(label_id) AS label_ids
                      FROM issue_labels GROUP BY issue_id) il ON il.issue_id = i.id
        WHERE i.id <> ?
          AND i.project_id = ?
          AND i.archived = 0
          AND NOT EXISTS (SELECT 1 FROM issue_links l
                           WHERE (l.source_issue_id = i.id AND l.target_issue_id = ?)
                              OR (l.target_issue_id = i.id AND l.source_issue_id = ?))`,
      [issueId, issue.project_id, issueId, issueId],
    );
    const labelMap = this.labelIdsFor(rows.map((row) => row.id));
    const strategies = [...defaultStrategies().values()];
    const pairs = this.compare(
      [source, ...rows.map((row) => this.toComparable(row, labelMap.get(row.id) ?? []))],
      strategies,
      0.4,
    );
    return pairs
      .filter((candidate) => candidate.sourceIssueId === issueId || candidate.candidateIssueId === issueId)
      .slice(0, limit);
  }

  // -------------------------------------------------------------------------
  // Review queue
  // -------------------------------------------------------------------------

  /**
   * Persist one candidate as an `is_duplicated_by` link.
   *
   * Direction: `candidateIssueId` is the ticket believed to be the newer
   * duplicate, so the stored edge runs *from the candidate to the source issue*.
   * Both issues get a timeline entry naming the other one.
   */
  link(candidate: DuplicateCandidate, actor: Actor, ctx: RequestContext): DuplicateCandidate {
    const at = nowIso();
    const actorId = Number(actor.userId);

    this.db.transaction(() => {
      this.db.run(
        `INSERT OR IGNORE INTO issue_links
           (source_issue_id, target_issue_id, kind, auto_detected, confidence, created_by, created_at)
         VALUES (?,?,?,1,?,?,?)`,
        [
          candidate.candidateIssueId,
          candidate.sourceIssueId,
          'is_duplicated_by',
          candidate.confidence,
          actorId,
          at,
        ],
      );

      for (const [issueId, otherKey] of [
        [candidate.sourceIssueId, candidate.candidateKey],
        [candidate.candidateIssueId, candidate.sourceKey],
      ] as Array<[number, string]>) {
        const issue = this.db.get<{ project_id: number }>(
          'SELECT project_id FROM issues WHERE id = ?',
          [issueId],
        );
        if (!issue) continue;
        this.services.activity.record({
          issueId,
          projectId: issue.project_id,
          actorId,
          type: 'issue.duplicate_detected',
          summary: `possible duplicate of ${otherKey} (${Math.round(candidate.confidence * 100)}% match)`,
          metadata: {
            strategy: candidate.strategy,
            confidence: candidate.confidence,
            sharedTokens: candidate.sharedTokens,
            autoLinked: true,
          },
        });
      }

      this.services.audit.record(
        {
          action: 'issue.updated',
          entityType: 'issue_link',
          entityId: `${candidate.sourceIssueId}:${candidate.candidateIssueId}`,
          after: {
            kind: 'is_duplicated_by',
            autoDetected: true,
            confidence: candidate.confidence,
            strategy: candidate.strategy,
          },
          actorId,
        },
        ctx.auditContext,
      );
    });

    return candidate;
  }

  /** Auto-detected links waiting for a human decision, newest first. */
  listPending(projectId: number): Array<{
    linkId: number;
    sourceIssueId: number;
    sourceKey: string;
    sourceTitle: string;
    targetIssueId: number;
    targetKey: string;
    targetTitle: string;
    confidence: number | null;
    createdAt: string;
  }> {
    return this.db
      .all<Record<string, unknown>>(
        `SELECT l.id, l.confidence, l.created_at,
                s.id AS source_id, s.key AS source_key, s.title AS source_title,
                t.id AS target_id, t.key AS target_key, t.title AS target_title
           FROM issue_links l
           JOIN issues s ON s.id = l.source_issue_id
           JOIN issues t ON t.id = l.target_issue_id
          WHERE l.auto_detected = 1
            AND s.project_id = ?
          ORDER BY l.created_at DESC, l.id DESC`,
        [projectId],
      )
      .map((row) => ({
        linkId: Number(row.id),
        sourceIssueId: Number(row.source_id),
        sourceKey: String(row.source_key),
        sourceTitle: String(row.source_title),
        targetIssueId: Number(row.target_id),
        targetKey: String(row.target_key),
        targetTitle: String(row.target_title),
        confidence: row.confidence === null ? null : Number(row.confidence),
        createdAt: String(row.created_at),
      }));
  }

  /**
   * Reject an auto-detected link. Human-created links are refused: dismissing
   * one would silently destroy a decision someone made on purpose.
   */
  dismiss(linkId: number, actor: Actor, ctx: RequestContext): { dismissed: boolean } {
    const link = this.db.get<{ id: number; auto_detected: number; source_issue_id: number }>(
      'SELECT id, auto_detected, source_issue_id FROM issue_links WHERE id = ?',
      [linkId],
    );
    if (!link) throw notFound('Issue link', linkId);
    if (link.auto_detected !== 1) {
      throw new Error('This link was created by a person and cannot be auto-dismissed');
    }

    this.db.transaction(() => {
      this.db.run('DELETE FROM issue_links WHERE id = ? AND auto_detected = 1', [linkId]);
      this.services.audit.record(
        {
          action: 'issue.updated',
          entityType: 'issue_link',
          entityId: linkId,
          before: { linkId, autoDetected: true },
          after: { linkId, dismissed: true },
          actorId: Number(actor.userId),
        },
        ctx.auditContext,
      );
    });
    return { dismissed: true };
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private selectStrategies(ids: DedupeStrategy[]): SimilarityStrategy[] {
    const available = defaultStrategies();
    return ids
      .map((id) => available.get(id))
      .filter((strategy): strategy is SimilarityStrategy => strategy !== undefined);
  }

  private loadCandidates(input: DedupeScanInput): CandidateRow[] {
    const clauses = ['i.archived = 0'];
    const params: Array<string | number> = [];
    if (input.projectId !== undefined) {
      clauses.push('i.project_id = ?');
      params.push(input.projectId);
    }
    if (input.openOnly) {
      clauses.push(
        `i.state NOT IN (${['resolved', 'closed', 'wont_fix', 'duplicate']
          .map(() => '?')
          .join(', ')})`,
      );
      params.push('resolved', 'closed', 'wont_fix', 'duplicate');
    }
    const rows = this.db.all<Row>(
      `SELECT i.id, i.key, i.title, i.type, i.project_id, i.state,
              COALESCE(il.label_ids, '') AS label_ids
         FROM issues i
         LEFT JOIN (SELECT issue_id, group_concat(label_id) AS label_ids
                      FROM issue_labels GROUP BY issue_id) il ON il.issue_id = i.id
        WHERE ${clauses.join(' AND ')}
        ORDER BY i.id
        LIMIT ?`,
      [...params, MAX_SCAN_ROWS],
    );
    const labelMap = this.labelIdsFor(rows.map((row) => row.id));
    return rows.map((row) => ({ ...row, labelIds: labelMap.get(row.id) ?? [] }));
  }

  private labelIdsFor(issueIds: number[]): Map<number, number[]> {
    const map = new Map<number, number[]>();
    if (issueIds.length === 0) return map;
    // One query with a chunked IN clause rather than a lookup per issue.
    for (let index = 0; index < issueIds.length; index += 400) {
      const chunk = issueIds.slice(index, index + 400);
      const rows = this.db.all<{ issue_id: number; label_id: number }>(
        `SELECT issue_id, label_id FROM issue_labels WHERE issue_id IN ${inClause(chunk.length)}`,
        chunk,
      );
      for (const row of rows) {
        const list = map.get(row.issue_id) ?? [];
        list.push(row.label_id);
        map.set(row.issue_id, list);
      }
    }
    return map;
  }

  private toComparable(row: Row, labelIds: number[]): DedupeComparable {
    return { id: row.id, key: row.key, title: row.title, type: row.type, labelIds };
  }

  /**
   * Score every plausible pair and keep the strongest strategy per pair.
   *
   * Above {@link BUCKET_THRESHOLD} issues the candidate set is bucketed by
   * normalised-title prefix and by shared label, and only issues that land in a
   * common bucket are compared. That trades a small chance of missing a
   * cross-bucket duplicate for a comparison count that stays linear-ish in the
   * size of the duplicate clusters instead of quadratic in the project.
   */
  private compare(
    rows: DedupeComparable[],
    strategies: SimilarityStrategy[],
    minConfidence: number,
  ): DuplicateCandidate[] {
    if (rows.length <= 1 || strategies.length === 0) return [];
    const pairs = this.candidatePairs(rows);

    const out: DuplicateCandidate[] = [];
    for (const [leftIndex, rightIndex] of pairs) {
      const left = rows[leftIndex];
      const right = rows[rightIndex];
      if (!left || !right) continue;
      let best: DuplicateCandidate | null = null;
      for (const strategy of strategies) {
        const result = strategy.score(left, right);
        if (result.score < minConfidence) continue;
        if (best && result.score <= best.confidence) continue;
        best = {
          sourceIssueId: asIssueId(left.id),
          sourceKey: left.key,
          sourceTitle: left.title,
          candidateIssueId: asIssueId(right.id),
          candidateKey: right.key,
          candidateTitle: right.title,
          confidence: round4(result.score),
          strategy: strategy.id,
          sharedTokens: result.sharedTokens,
        };
      }
      if (best) out.push(best);
    }
    out.sort((a, b) => b.confidence - a.confidence || a.sourceKey.localeCompare(b.sourceKey));
    return out;
  }

  /** Index pairs to compare: all of them when small, bucketed when large. */
  private candidatePairs(rows: DedupeComparable[]): Array<[number, number]> {
    const total = rows.length;
    if (total <= BUCKET_THRESHOLD) {
      const pairs: Array<[number, number]> = [];
      for (let left = 0; left < total; left += 1) {
        for (let right = left + 1; right < total; right += 1) pairs.push([left, right]);
      }
      return pairs;
    }

    const buckets = new Map<string, number[]>();
    const add = (key: string, index: number) => {
      const list = buckets.get(key) ?? [];
      list.push(index);
      buckets.set(key, list);
    };
    rows.forEach((row, index) => {
      add(`t:${normaliseTitle(row.title).slice(0, BUCKET_PREFIX_LENGTH)}`, index);
      for (const labelId of row.labelIds) add(`l:${labelId}`, index);
    });

    const seen = new Set<string>();
    const pairs: Array<[number, number]> = [];
    for (const members of buckets.values()) {
      if (members.length < 2 || members.length > 200) continue;
      for (let a = 0; a < members.length; a += 1) {
        for (let b = a + 1; b < members.length; b += 1) {
          const left = members[a] as number;
          const right = members[b] as number;
          const key = left < right ? `${left}:${right}` : `${right}:${left}`;
          if (seen.has(key)) continue;
          seen.add(key);
          pairs.push(left < right ? [left, right] : [right, left]);
        }
      }
    }
    return pairs;
  }
}

/** Absolute ceiling on a single scan, whatever the caller asked for. */
export const MAX_SCAN_ROWS = 5_000;

/** Keep confidence values stable across runs so links compare cleanly. */
function round4(value: number): number {
  return Math.round(Math.min(1, Math.max(0, value)) * 10_000) / 10_000;
}
