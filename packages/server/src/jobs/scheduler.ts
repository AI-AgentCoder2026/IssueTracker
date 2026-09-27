/**
 * Background scheduler.
 *
 * A deliberately small set of periodic jobs, each of which must be idempotent
 * because they run on a timer and may overlap with a manual trigger:
 *
 *   sla.evaluate        every minute — warning and breach notifications
 *   archive.run         hourly     — auto-archive stale closed issues
 *   gitlab sync         every 5 min — pull remote changes into the tracker
 *   webhook.process     every 30 s  — deliver queued outgoing webhooks
 *   email drain         every 30 s  — deliver the durable email outbox
 */

import { nowIso } from '../lib/time.ts';
import { systemRequestContext, type Services } from '../services/context.ts';

export interface SchedulerOptions {
  /** Run every job once immediately on start. Useful for tests. */
  runOnStart?: boolean;
  /** Override the interval of a single job, in ms. */
  intervals?: Partial<Record<JobName, number>>;
}

export type JobName = 'sla' | 'archive' | 'gitlab' | 'webhooks' | 'email' | 'webauthn';

const DEFAULT_INTERVALS: Record<JobName, number> = {
  sla: 60_000,
  archive: 3_600_000,
  gitlab: 300_000,
  webhooks: 30_000,
  email: 30_000,
  webauthn: 300_000,
};

export class Scheduler {
  private readonly services: Services;
  private readonly options: SchedulerOptions;
  private readonly timers: NodeJS.Timeout[] = [];
  private readonly running = new Set<JobName>();
  private stopped = false;

  constructor(services: Services, options: SchedulerOptions = {}) {
    this.services = services;
    this.options = options;
  }

  private intervalFor(job: JobName): number {
    return this.options.intervals?.[job] ?? DEFAULT_INTERVALS[job];
  }

  /** Start every job. No-op when disabled in the config or in tests. */
  start(): void {
    if (this.stopped) return;
    if (!this.services.config.enableScheduler) return;

    for (const job of Object.keys(DEFAULT_INTERVALS) as JobName[]) {
      const timer = setInterval(() => {
        void this.runJob(job);
      }, this.intervalFor(job));
      // Never hold the event loop open on the scheduler's account.
      timer.unref?.();
      this.timers.push(timer);
    }

    if (this.options.runOnStart) {
      for (const job of Object.keys(DEFAULT_INTERVALS) as JobName[]) {
        void this.runJob(job);
      }
    }
  }

  stop(): void {
    this.stopped = true;
    for (const timer of this.timers.splice(0)) clearInterval(timer);
  }

  /**
   * Run one job, guarded against re-entry. A slow job must not stack up behind
   * the next tick.
   */
  async runJob(job: JobName): Promise<void> {
    if (this.running.has(job)) return;
    this.running.add(job);

    try {
      switch (job) {
        case 'sla':
          await this.services.sla.evaluate();
          return;
        case 'archive':
          await this.runArchive();
          return;
        case 'gitlab':
          await this.runGitlabSync();
          return;
        case 'webhooks':
          await this.services.webhooks.processPending(25);
          return;
        case 'email':
          await this.drainEmailOutbox();
          return;
      }
    } catch (error) {
      // A failing job must never take the process down; log and let the next
      // tick retry.
      this.services.audit.record(
        {
          action: 'settings.changed',
          entityType: 'scheduler',
          entityId: job,
          after: { job, error: (error as Error).message, at: nowIso() },
        },
        { actorName: 'scheduler' },
      );
    } finally {
      this.running.delete(job);
    }
  }

  /** Archive stale issues for every project that opted in. */
  private async runArchive(): Promise<void> {
    const projects = this.services.db.all<{ id: number }>(
      "SELECT id FROM projects WHERE archive_policy IS NOT NULL AND archive_policy != '{}'",
    );
    for (const project of projects) {
      await this.services.archive.run(Number(project.id), null, systemRequestContext(this.services, 'archive-scheduler'));
    }
  }

  /** Pull from every enabled GitLab connection. */
  private async runGitlabSync(): Promise<void> {
    const connections = this.services.db.all<{ id: number }>(
      'SELECT id FROM gitlab_connections WHERE enabled = 1',
    );
    for (const connection of connections) {
      await this.services.gitlab
        .sync(Number(connection.id), { direction: 'pull', trigger: 'schedule', actorId: null })
        .catch(() => {
          // Per-connection failures are recorded on the connection row by the
          // sync engine; nothing further to do here.
        });
    }
  }

  /**
   * Deliver queued email through the configured transport.
   *
   * With no transport configured the outbox simply accumulates, and
   * `MailService.drain` records why — which is the correct behaviour for a
   * self-hosted instance that only uses in-app notifications.
   */
  private async drainEmailOutbox(): Promise<void> {
    await this.services.mail.drain(25);
  }
}
