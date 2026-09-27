/**
 * Identifier types.
 *
 * These are deliberately **plain aliases of `number`, not branded types**.
 *
 * A branded id (`UserId & { readonly __brand: 'UserId' }`) looks attractive —
 * it stops you passing a `ProjectId` where an `IssueId` is expected. In
 * practice, though, every id in this codebase arrives from a database row as
 * `unknown` and leaves through `Number(...)` at the HTTP boundary. Enforcing the
 * brand therefore bought very little real safety while forcing a cast at
 * essentially every mapping site.
 *
 * The named aliases are kept because they document intent in signatures, which
 * is where the value actually is: `assigneeId: UserId | null` reads better than
 * `assigneeId: number | null`, and a reader immediately knows whether a field
 * points at a row in `users` or at an issue.
 *
 * To restore full enforcement later, add the brand back here alone; nothing
 * else in the codebase needs to change.
 */

/** A row in `users`. */
export type UserId = number;
/** A row in `projects`. */
export type ProjectId = number;
/** A row in `issues`. */
export type IssueId = number;
/** A row in `comments`. */
export type CommentId = number;
/** A row in `attachments`. */
export type AttachmentId = number;
/** A row in `workflow_statuses`. */
export type StatusId = number;
/** A row in `workflow_transitions`. */
export type TransitionId = number;
/** A row in `workflows`. */
export type WorkflowId = number;
/** A row in `labels`. */
export type LabelId = number;
/** A row in `milestones`. */
export type MilestoneId = number;
/** A row in `dashboards`. */
export type DashboardId = number;
/** A row in `notifications`. */
export type NotificationId = number;
/** A row in `webhooks`. */
export type WebhookId = number;
/** A row in `gitlab_connections`. */
export type GitLabConnectionId = number;
/** A row in `sla_policies`. */
export type SlaPolicyId = number;

/**
 * Ids read from the database are `unknown` until checked. `toId` is the single
 * place that conversion happens, so a malformed row fails loudly at the edge
 * instead of propagating as `NaN` into a query.
 */
export function toId(value: unknown, entity: string): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Expected a positive integer id for ${entity}, received ${String(value)}`);
  }
  return parsed;
}

/**
 * Identity casts. These are intentionally thin: they exist so a call site can
 * document that a raw database number *is* a particular entity, without the
 * ceremony of a branded type. Prefer a direct `as` when the intent is obvious.
 */
export const asUserId = (n: number): UserId => n;
export const asProjectId = (n: number): ProjectId => n;
export const asIssueId = (n: number): IssueId => n;
export const asCommentId = (n: number): CommentId => n;
export const asAttachmentId = (n: number): AttachmentId => n;
export const asStatusId = (n: number): StatusId => n;
export const asTransitionId = (n: number): TransitionId => n;
export const asWorkflowId = (n: number): WorkflowId => n;
export const asLabelId = (n: number): LabelId => n;
export const asMilestoneId = (n: number): MilestoneId => n;
export const asDashboardId = (n: number): DashboardId => n;
export const asNotificationId = (n: number): NotificationId => n;
export const asWebhookId = (n: number): WebhookId => n;
export const asGitLabConnectionId = (n: number): GitLabConnectionId => n;
export const asSlaPolicyId = (n: number): SlaPolicyId => n;

/** ISO-8601 UTC timestamp string, e.g. `2026-09-27T12:00:00.000Z`. */
export type IsoDateTime = string;
