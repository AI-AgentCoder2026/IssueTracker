# Foundation contract

Everything below is **already implemented and must be used as-is**. Do not
re-implement, re-export, or wrap these modules. If something here is missing,
say so instead of inventing a parallel version.

## Monorepo layout

```
issue-tracker/
  packages/shared/   @tracker/shared — built to packages/shared/dist
  packages/server/   @tracker/server — the API
  packages/web/      @tracker/web — the SPA
```

- Node 24, ESM only, `"type": "module"`.
- **Relative imports use the `.ts` extension** (`import { x } from './y.ts'`).
  `tsconfig` has `allowImportingTsExtensions` + `rewriteRelativeImportExtensions`,
  so `tsc` rewrites them to `.js` in `dist`. Node's `--experimental-strip-types`
  does *not* remap `.js`→`.ts`, which is why `.ts` is required.
- No enums, no namespaces, no parameter properties, no `declare module` — the
  code must run under Node's type stripping.
- Strict TypeScript, `noUncheckedIndexedAccess: true`.

## `@tracker/shared`

Import from the package root. Notable exports:

| Area | Exports |
| --- | --- |
| Ids | `UserId`, `IssueId`, `ProjectId`, `StatusId`, … and `asIssueId(n)` casts |
| RBAC | `Role`, `ROLES`, `Permission`, `Permission`, `can(actor, permission, ctx)`, `Actor`, `AccessContext`, `ROLE_RANK`, `roleAtLeast` |
| Issues | `Issue`, `IssueSummary`, `IssueTiming`, `IssueType`, `IssuePriority`, `IssueState`, `DependencyKind`, `createIssueSchema`, `updateIssueSchema`, `isTerminalState`, `PRIORITY_RANK` |
| Workflow | `Workflow`, `WorkflowStatus`, `WorkflowTransition`, `TransitionCheck`, `DEFAULT_STATUSES`, `createStatusSchema`, `createTransitionSchema`, `transitionRequestSchema` |
| Comments | `Comment`, `Mention`, `extractMentionUsernames`, `createCommentSchema`, `NOTIFICATION_EVENTS` |
| Auth | `User`, `Membership`, `ApiToken`, `GuestToken`, `Session`, `registerSchema`, `loginSchema`, `createGuestTokenSchema` |
| GitLab | `SyncMode`, `SYNC_MODES`, `SYNC_MODE_LABEL`, `GitLabConnectionPublic`, `ExternalLink`, `SyncConflict`, `SyncRun`, `createConnectionSchema`, `GitLabIssuePayload`, `GitLabProjectPayload` |
| Dashboards | `WidgetType`, `WIDGET_TYPES`, `WidgetData`, `RenderedWidget`, `RenderedDashboard`, `DASHBOARD_TEMPLATES`, `createWidgetSchema`, `createDashboardSchema` |
| Audit | `ActivityEvent`, `ActivityType`, `ACTIVITY_TYPES`, `AuditEntry`, `AuditAction`, `AuditChainVerification`, `canonicalJson` |
| Realtime | `ServerEvent`, `WS_PATH`, `PresenceEntry`, `BoardUpdate` |
| Search/bulk | `IssueSearchQuery`, `searchQuerySchema`, `toFtsMatchExpression`, `BulkOperation`, `bulkEditSchema`, `exportRequestSchema`, `dedupeScanSchema`, `DuplicateCandidate`, `archivePolicySchema`, `SlaPolicy`, `SlaStatus`, `createSlaPolicySchema` |
| Common | `Project`, `Label`, `Milestone`, `createProjectSchema`, `ErrorCode`, `AppError` body shape, `encodeCursor`, `decodeCursor` |

## Server modules you must build on

### `src/config.ts`

```ts
loadConfig(overrides?: Partial<Config>): Config
```
`Config` fields: `env`, `host`, `port`, `publicUrl`, `dataDir`, `databaseFile`,
`uploadDir`, `encryptionKey: Buffer`, `sessionSecret: Buffer`,
`sessionTtlSeconds`, `corsOrigins: string[]`, `serveWebClient`, `webClientDir`,
`maxUploadBytes`, `logLevel`, `enableScheduler`, `webhookTimeoutMs`,
`gitlabTimeoutMs`, `bootstrapAdminEmail`, `bootstrapAdminPassword`,
`trustProxy`.

### `src/errors.ts`

```ts
class AppError extends Error { code; status; details; fields; expose; toBody(requestId?): ApiErrorBody }
badRequest(msg, details?)          // 400
unauthenticated(msg?)              // 401
forbidden(msg?)                    // 403
notFound(entity, id?)              // 404
conflict(msg, details?)            // 409
versionConflict(current, expected) // 409
workflowViolation(msg, details?)   // 422
cycleDetected(msg?)                // 422
integrationError(msg, details?)    // 502
internalError(msg?, cause?)        // 500, never exposed to clients
fromZodError(err): AppError        // 422 with per-field details
```
**Rules:** throw these from services. Never let a raw SQLite/Node error escape
to a client. Use `notFound('Issue', id)` — capitalised entity name.

### `src/db/connection.ts`

```ts
class Database {
  constructor(options: { file: string; wal?: boolean; cacheSize?: number })
  run(sql, params: SqlParam[] = []): { changes: number; lastInsertRowid: number }
  get<T>(sql, params: SqlParam[] = []): T | undefined
  all<T>(sql, params: SqlParam[] = []): T[]
  scalar<T>(sql, params: SqlParam[] = []): T | undefined   // first column of first row
  exec(sql): void                                          // raw DDL / multi-statement
  transaction<T>(fn: () => T): T                           // re-entrant: nested calls join the outer
  get inTransaction(): boolean
  close(): void
}
type SqlParam = string | number | bigint | null | Uint8Array
placeholders(n): string   // "?, ?, ?"
inClause(n): string       // "(?, ?, ?)"
```

**Rules:**
- Every value is bound. Never interpolate user input into SQL. The only
  interpolated fragments are `placeholders()` / `inClause()` lengths.
- Wrap multi-statement writes in `db.transaction(...)`.
- Rows come back snake_case; map them to the camelCase shapes in
  `@tracker/shared` in a private `mapRow` method.
- Booleans are stored as `INTEGER 0/1` — convert with `Number(x) === 1`.
- JSON columns are `TEXT` — `JSON.stringify` on write, `JSON.parse` on read.

### `src/db/migrate.ts`

`migrate(db, { log? })`, `migrationStatus(db)`, `listMigrations()`,
`appliedMigrations(db)`.

### `src/db/migrations/001_init.sql`

**Read this file before writing SQL.** It is the authoritative schema. Key points:

- All tables are `STRICT`. Timestamps are ISO-8601 UTC
  (`strftime('%Y-%m-%dT%H:%M:%fZ','now')`), stored as `TEXT`.
- Tables: `users`, `external_identities`, `sso_configurations`, `sessions`,
  `api_tokens`, `guest_tokens`, `projects`, `project_members`, `workflows`,
  `workflow_statuses`, `workflow_transitions`, `labels`, `milestones`, `issues`,
  `issue_labels`, `issue_links`, `comments`, `comment_mentions`, `attachments`,
  `watchers`, `activity_events`, `audit_log`, `notifications`,
  `notification_preferences`, `email_outbox`, `dashboards`,
  `dashboard_widgets`, `sla_policies`, `sla_clocks`, `gitlab_connections`,
  `gitlab_external_links`, `gitlab_sync_runs`, `gitlab_sync_conflicts`,
  `webhooks`, `webhook_deliveries`, `webhook_receipts`.
- `issues.position` is `REAL` so a Kanban card can be ordered fractionally
  between two rows.
- `issues.version` is bumped on every write; clients send `expectedVersion`.
- `audit_log` has `BEFORE UPDATE`/`BEFORE DELETE` triggers that `RAISE(ABORT)`.
  Never attempt to modify it.
- FTS5: `issue_search(title, description, key)` and `comment_search(body)` are
  maintained by triggers on `issues` and `comments`. You do **not** write to
  them directly; query them with a `MATCH` expression.

### `src/lib/crypto.ts`

```ts
hashPassword(pw): string          // "scrypt$N$r$p$salt$hash"
verifyPassword(pw, stored): boolean
needsPasswordRehash(stored): boolean
generateToken(bytes = 32): string // base64url, 256-bit
generateSessionId(): string
tokenPrefix(token): string        // first 8 chars
hashToken(token): string           // sha256 hex, for storing tokens
encrypt(plaintext, key): string    // AES-256-GCM, base64url
decrypt(payload, key): string
sha256Hex(input): string
hmacSha256Hex(secret, payload): string
safeEqual(a, b): boolean           // constant-time
maskSecret(secret, visible = 4): string
scrubSecrets(input, { except?, includeEmail? }): string
```

### `src/lib/time.ts`

```ts
nowIso(): string                 // the ONLY way to get "now"
toIso(date): string
addMs(iso, ms): string  addMinutes(iso, min): string  addDays(iso, days): string
msUntil(iso, from?): number  isPast(iso, from?): boolean
parseDuration("1h30m"): number | null
formatDuration(ms): string       // "2d 4h"
addBusinessMs(from, ms, { startHour, endHour, workingDays }): string
startOfIsoWeek(iso): Date  daysBetween(a, b): number  ageBucket(iso): string
MINUTE_MS, HOUR_MS, DAY_MS
```

### `src/services/audit.service.ts`

```ts
class AuditService {
  constructor(db: Database)
  record(input: AuditInput, context?: RequestAuditContext): AuditEntry
  recordMany(inputs: AuditInput[], context?): AuditEntry[]
  verifyChain(options?): AuditChainVerification
  list(query): { entries: AuditEntry[]; total: number; nextCursor: number | null }
  historyFor(entityType, entityId, limit?): AuditEntry[]
  static canonicalAuditPayload(entry): string
}
```
`AuditInput` = `{ action, entityType, entityId?, projectId?, before?, after?,
actorId?, actorName?, actorEmail?, ipAddress?, userAgent?, createdAt? }`.
`before`/`after` are plain objects or `undefined` (omitted → `null` in the row).

**Rule:** every state-changing service records an audit entry. Pass
`before`/`after` snapshots of the fields that changed.

### `src/services/activity.service.ts`

```ts
class ActivityService {
  constructor(db: Database)
  record(input: ActivityInput): ActivityEvent
  recordFieldChange({ issueId, projectId, actorId?, type, before, after, fields, labels? }): ActivityEvent
  forIssue(issueId, { limit?, types? }): ActivityEvent[]
  forProject(projectId, { limit?, since?, types? }): ActivityEvent[]
  forActor(actorId, limit?): ActivityEvent[]
  static diff(before, after, fields): FieldChange[]
}
```

### `src/services/notification.service.ts`

```ts
class NotificationService {
  constructor(db: Database)
  notify(input: NotifyInput, options?: { excludeUserIds?: number[] }): NotifyResult
  listForUser(userId, { limit?, unreadOnly? }): { notifications; unreadCount }
  markRead(userId, ids, readAt?): number
  markAllRead(userId, readAt?): number
  setPreference(userId, event, inApp, email): void
  listPreferences(userId): Array<{ event; inApp; email }>
}
```
`notify` resolves the audience automatically (assignee, reporter, watchers,
previous commenters, mentions), honours per-user preferences, and queues email
into `email_outbox`. Pass `excludeUserIds: [actorId]` so the actor is not
notified of their own action.

### `src/realtime/hub.ts`

```ts
class RealtimeHub {
  subscribe(channelName, subscriber: (data: string) => void): () => void
  publish(input: PublishInput, options?: PublishOptions): number
  setPresence(entry & { connectionId }): void
  clearPresence(userId, connectionId): void
  presenceForProject(projectId): PresenceEntry[]
  prunePresence(): number
  stats(): { channels; subscribers; presenceEntries }
  reset(): void
}
```
Channels: `project:<id>`, `issue:<id>`, `dashboard:<id>`, `user:<id>`.
Typical calls:
```ts
realtime.publish({ event: 'issue.updated', projectId, issueId, data: summary });
realtime.publish({ event: 'board.updated', projectId, data: boardUpdate });
realtime.publish({ event: 'notification', userIds: [userId], data: notification });
```

## Route conventions

Every route module exports a Fastify plugin:

```ts
import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import type { RequestContext } from '../services/context.ts';

export const projectRoutes: FastifyPluginAsync = async (app: FastifyInstance) => {
  app.get('/api/projects', async (request) => {
    const ctx = request.context;   // provided by the auth plugin
    // ...
  });
};
export default projectRoutes;
```

- **Prefix every path with `/api`**, except Webhook receivers which use
  `/webhooks/...`, and the WebSocket upgrade which uses `/ws`.
- `request.context` is the `RequestContext` (see `src/services/context.ts`):
  `{ config, db, services, actor, requestId, ip, userAgent, auditContext }`.
- `request.actor` is the authenticated `Actor` from `@tracker/shared`, or the
  guest actor for a guest token.
- Validate bodies with the zod schemas in `@tracker/shared`:
  ```ts
  const body = createIssueSchema.parse(request.body);
  ```
  A thrown `ZodError` is converted to a 422 by the global error handler.
- Use the shared `Decision` from `can()`:
  ```ts
  const decision = can(ctx.actor, 'issue.create', { projectId });
  if (!decision.allowed) throw forbidden(decision.reason);
  ```
- Return plain JSON matching the `@tracker/shared` types. Do not wrap in an
  envelope unless the shared type says so.
- Add a `schema` object to the route for body validation/serialization where it
  is cheap, but zod parsing in the handler is acceptable and preferred for
  consistency.

## Definition of done for every file you own

- Compiles under `npm run typecheck` in `packages/server` (strict, no `any`
  without a comment explaining why).
- No SQL string interpolation of user values.
- Every state change records an audit entry; user-visible changes also append an
  activity event.
- Public methods are documented with a short JSDoc comment stating behaviour and
  any non-obvious invariant.
- No `console.log` — the Fastify logger is injected.
