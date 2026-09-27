/**
 * Service registry.
 *
 * Construction is two-phase: the leaf services are created first, then the
 * services that collaborate (issue → notifications/activity/audit/realtime) are
 * handed the partially-filled registry. Because collaborators are only
 * dereferenced at call time, this avoids a module import cycle while still
 * letting any service reach any other.
 */

import type { Config } from '../config.ts';
import { Database } from '../db/connection.ts';
import { migrate } from '../db/migrate.ts';
import { RealtimeHub } from '../realtime/hub.ts';
import { ActivityService } from './activity.service.ts';
import { AuditService } from './audit.service.ts';
import { NotificationService } from './notification.service.ts';
import { MailService } from './mail.service.ts';
import { WebAuthnService } from './webauthn.service.ts';
import { AuthService } from './auth.service.ts';
import { ProjectService } from './project.service.ts';
import { WorkflowService } from './workflow.service.ts';
import { IssueService } from './issue.service.ts';
import { CommentService } from './comment.service.ts';
import { AttachmentService } from './attachment.service.ts';
import { SearchService } from './search.service.ts';
import { BulkService } from './bulk.service.ts';
import { ExportService } from './export.service.ts';
import { DedupeService } from './dedupe.service.ts';
import { ArchiveService } from './archive.service.ts';
import { TimingService } from './timing.service.ts';
import { SlaService } from './sla.service.ts';
import { DashboardService } from './dashboard.service.ts';
import { VersionControlService } from './versioncontrol.service.ts';
import { GitLabService } from './gitlab/sync.service.ts';
import { WebhookService } from './webhook.service.ts';
import type { Services } from './context.ts';

export interface RegistryOptions {
  config: Config;
  db: Database;
  /** Reuse an existing hub, e.g. when a test builds two apps. */
  realtime?: RealtimeHub;
}

export function createServices(options: RegistryOptions): Services {
  const { config, db } = options;
  const realtime = options.realtime ?? new RealtimeHub();

  // Phase 1: leaf services that need nothing but the database.
  const audit = new AuditService(db);
  const activity = new ActivityService(db);
  const notifications = new NotificationService(db);
  const mail = new MailService(config, db);

  // Phase 2: an object that already exposes phase 1. Services hold this
  // reference and fill in the rest as construction proceeds.
  const services = {
    config,
    db,
    audit,
    activity,
    notifications,
    realtime,
  } as Services;

  services.auth = new AuthService(services);
  services.workflow = new WorkflowService(services);
  services.projects = new ProjectService(services);
  services.issues = new IssueService(services);
  services.comments = new CommentService(services);
  services.attachments = new AttachmentService(services);
  services.search = new SearchService(services);
  services.bulk = new BulkService(services);
  services.export = new ExportService(services);
  services.dedupe = new DedupeService(services);
  services.archive = new ArchiveService(services);
  services.timing = new TimingService(services);
  services.sla = new SlaService(services);
  services.dashboards = new DashboardService(services);
  services.versionControl = new VersionControlService(services);
  services.webauthn = new WebAuthnService(services);
  services.gitlab = new GitLabService(services);
  services.webhooks = new WebhookService(services);

  return services;
}

/** Open a database for `config` and run pending migrations. */
export function openDatabase(
  config: Config,
  options: { migrate?: boolean; log?: (message: string) => void } = {},
): Database {
  const db = new Database({
    file: config.databaseFile,
    wal: config.env !== 'test',
  });

  if (options.migrate !== false) {
    migrate(db, { log: options.log });
  }

  return db;
}
