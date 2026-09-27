/**
 * Service registry and per-request context.
 *
 * This module is **types only** — it imports no concrete service classes, which
 * keeps the dependency graph acyclic. `src/services/registry.ts` builds the
 * object; route modules consume it through `RequestContext`.
 *
 * Two-phase construction is deliberate: the registry creates the leaf services
 * first, then passes the partially-filled registry to services that need
 * collaborators (an issue change fans out to notifications, activity, audit,
 * realtime and webhooks). Because those collaborators are only dereferenced when
 * a method is *called*, a service may safely hold the registry reference.
 */

import type { Actor } from '@tracker/shared';
import type { Config } from '../config.ts';
import type { Database } from '../db/connection.ts';
import { badRequest } from '../errors.ts';
import type { RealtimeHub } from '../realtime/hub.ts';
import type { ActivityService } from './activity.service.ts';
import type { AuditService, RequestAuditContext } from './audit.service.ts';
import type { NotificationService } from './notification.service.ts';
import type { MailService } from './mail.service.ts';
import type { WebAuthnService } from './webauthn.service.ts';

export type { RequestAuditContext };
import type { AuthService } from './auth.service.ts';
import type { ProjectService } from './project.service.ts';
import type { WorkflowService } from './workflow.service.ts';
import type { IssueService } from './issue.service.ts';
import type { CommentService } from './comment.service.ts';
import type { AttachmentService } from './attachment.service.ts';
import type { SearchService } from './search.service.ts';
import type { BulkService } from './bulk.service.ts';
import type { ExportService } from './export.service.ts';
import type { DedupeService } from './dedupe.service.ts';
import type { ArchiveService } from './archive.service.ts';
import type { TimingService } from './timing.service.ts';
import type { VersionControlService } from './versioncontrol.service.ts';
import type { SlaService } from './sla.service.ts';
import type { DashboardService } from './dashboard.service.ts';
import type { GitLabService } from './gitlab/sync.service.ts';
import type { WebhookService } from './webhook.service.ts';

/**
 * Every long-lived service, constructed once per process.
 *
 * Add new services to this interface and to `registry.ts` together; the type
 * checker will point at any route that uses a service you forgot to wire.
 */
export interface Services {
  config: Config;
  db: Database;

  // Cross-cutting
  audit: AuditService;
  activity: ActivityService;
  notifications: NotificationService;
  mail: MailService;
  webauthn: WebAuthnService;
  realtime: RealtimeHub;

  // Identity
  auth: AuthService;

  // Structure
  projects: ProjectService;
  workflow: WorkflowService;

  // Issue lifecycle
  issues: IssueService;
  comments: CommentService;
  attachments: AttachmentService;

  // Find & organise
  search: SearchService;
  bulk: BulkService;
  export: ExportService;
  dedupe: DedupeService;
  archive: ArchiveService;

  // Measurement
  timing: TimingService;
  sla: SlaService;
  dashboards: DashboardService;

  // Integrations
  versionControl: VersionControlService;
  gitlab: GitLabService;
  webhooks: WebhookService;
}

/**
 * Everything a route handler needs, assembled once per request by the auth
 * plugin and attached as `request.context`.
 */
export interface RequestContext {
  services: Services;
  db: Database;
  config: Config;
  /** The authenticated principal, or a synthetic guest actor. */
  actor: Actor;
  /** Present when the request authenticated with a guest token. */
  guest: {
    id: number;
    projectId: number;
    /** Set when the link is scoped to a single issue. */
    issueId: number | null;
    role: 'viewer' | 'reporter';
    canComment: boolean;
    label: string;
  } | null;
  requestId: string;
  ip: string;
  userAgent: string;
  /** Pre-filled actor identity, merged into every audit entry this request records. */
  auditContext: RequestAuditContext;
}

/** Narrow a context to a project the actor can actually see. */
export function requireProjectContext(ctx: RequestContext, projectId: number): { projectId: number } {
  return { projectId };
}

/** Parse `:projectId` / `:issueId` style params into numbers, or throw. */
export function parseId(value: unknown, entity: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    // A non-numeric id is a client error; `badRequest` keeps the response shape
    // consistent with validation failures elsewhere.
    throw badRequest(`Invalid ${entity} id: ${String(value)}`);
  }
  return parsed;
}

/**
 * Synthetic principal for background jobs.
 *
 * It is not an instance admin and holds no project roles, so a service that
 * checks RBAC will still refuse it. Jobs that operate on a project's own
 * configuration — retention policy, SLA clocks, sync — must pass `actor: null`
 * instead, which those services treat as an explicit system path.
 */
export const SYSTEM_ACTOR: Actor = {
  userId: 0,
  isInstanceAdmin: false,
  roles: [],
  projectRoles: new Map(),
};

/**
 * Build a `RequestContext` for a background job that needs one (for example to
 * be forwarded to a service that takes a context rather than loose fields).
 */
export function systemRequestContext(services: Services, label: string): RequestContext {
  return {
    services,
    db: services.db,
    config: services.config,
    actor: SYSTEM_ACTOR,
    guest: null,
    requestId: `job-${label}`,
    ip: 'system',
    userAgent: label,
    auditContext: { actorName: label, ipAddress: 'system', userAgent: label },
  };
}
