/**
 * Seed script: creates a realistic demo instance so the UI has something to show
 * on first run.
 *
 * Idempotent — it refuses to run if a user with the demo username already
 * exists, so re-running is safe.
 */

import { hashPassword } from '../lib/crypto.ts';
import { addDays, nowIso } from '../lib/time.ts';
import { pathToFileURL } from 'node:url';
import { Database } from './connection.ts';
import { migrate } from './migrate.ts';
import { createServices } from '../services/registry.ts';
import { loadConfig } from '../config.ts';
import type { Services } from '../services/context.ts';

const DEMO_USERNAME = 'admin';

interface SeedUser {
  username: string;
  email: string;
  displayName: string;
  password: string;
  instanceRole: 'user' | 'staff' | 'admin';
  role: 'owner' | 'admin' | 'maintainer' | 'developer' | 'reporter' | 'viewer';
}

const USERS: SeedUser[] = [
  {
    username: 'admin',
    email: 'admin@example.com',
    displayName: 'Ada Admin',
    password: 'ChangeMe123!',
    instanceRole: 'admin',
    role: 'owner',
  },
  {
    username: 'mo',
    email: 'mo@example.com',
    displayName: 'Mo Maintainer',
    password: 'ChangeMe123!',
    instanceRole: 'user',
    role: 'maintainer',
  },
  {
    username: 'dee',
    email: 'dee@example.com',
    displayName: 'Dee Developer',
    password: 'ChangeMe123!',
    instanceRole: 'user',
    role: 'developer',
  },
  {
    username: 'ravi',
    email: 'ravi@example.com',
    displayName: 'Ravi Reporter',
    password: 'ChangeMe123!',
    instanceRole: 'user',
    role: 'reporter',
  },
  {
    username: 'kim',
    email: 'kim@example.com',
    displayName: 'Kim Viewer',
    password: 'ChangeMe123!',
    instanceRole: 'user',
    role: 'viewer',
  },
];

interface SeedIssue {
  title: string;
  description: string;
  type: 'bug' | 'feature' | 'task' | 'incident' | 'chore' | 'question';
  priority: 'lowest' | 'low' | 'medium' | 'high' | 'highest' | 'critical';
  statusKey: string;
  assignee?: string;
  dueInDays?: number | null;
  estimate?: number;
  labels?: string[];
  comments?: Array<{ author: string; body: string; hoursAgo: number }>;
  children?: Array<{ title: string; statusKey: string }>;
  links?: Array<{ targetIndex: number; kind: 'blocks' | 'relates_to' | 'duplicates' }>;
}

const ISSUES: SeedIssue[] = [
  {
    title: 'Users cannot sign in with SSO after the IdP certificate rotates',
    description:
      'After the identity provider rotates its signing certificate, every SAML login fails with\n' +
      '`invalid_signature`. Reproduced on staging with the new certificate in place.',
    type: 'bug',
    priority: 'critical',
    statusKey: 'in_progress',
    assignee: 'dee',
    dueInDays: 1,
    estimate: 8,
    labels: ['Bug'],
    comments: [
      {
        author: 'mo',
        body: 'Confirmed on staging. The stored `idp_certificate` is pinned to the old cert.',
        hoursAgo: 20,
      },
      {
        author: 'dee',
        body: 'I will make certificate rotation a supported path rather than requiring a redeploy.',
        hoursAgo: 18,
      },
      { author: 'ravi', body: 'This blocked the whole QA sign-off run today. @mo any ETA?', hoursAgo: 4 },
    ],
    children: [
      { title: 'Support multiple IdP certificates during rotation', statusKey: 'in_progress' },
      { title: 'Add a certificate-expiry warning to the admin health check', statusKey: 'open' },
    ],
  },
  {
    title: 'Incident: elevated 500s on the search endpoint',
    description:
      'p95 latency on `/api/issues/search` spiked to 8s and 0.8% of requests returned 500.\n' +
      'Correlates with a full table scan introduced by a new index change.',
    type: 'incident',
    priority: 'critical',
    statusKey: 'resolved',
    assignee: 'mo',
    dueInDays: -1,
    estimate: 4,
    labels: ['Bug'],
    comments: [
      { author: 'mo', body: 'Rolled back the migration. Error rate is back to baseline.', hoursAgo: 30 },
    ],
  },
  {
    title: 'Bulk edit: assigning a milestone to issues across two projects',
    description:
      'A bulk `setMilestone` silently skips issues in a second project instead of reporting them\n' +
      'as a per-row failure.',
    type: 'bug',
    priority: 'high',
    statusKey: 'open',
    assignee: 'dee',
    dueInDays: 5,
    estimate: 3,
    labels: ['Bug'],
  },
  {
    title: 'Add SLA countdown widget to the leadership dashboard',
    description:
      'Leadership wants a single view of which issues are close to breaching their response SLA.',
    type: 'feature',
    priority: 'high',
    statusKey: 'in_review',
    assignee: 'dee',
    dueInDays: 3,
    estimate: 6,
    labels: ['Feature'],
    comments: [{ author: 'kim', body: 'Reviewed — looks good. One note on the empty state.', hoursAgo: 6 }],
  },
  {
    title: 'Document the GitLab source-of-truth modes',
    description:
      'Write up when to choose "tracker is canonical", "GitLab is canonical", or two-way sync, with a\n' +
      'worked conflict-resolution example.',
    type: 'task',
    priority: 'medium',
    statusKey: 'open',
    assignee: 'mo',
    dueInDays: 10,
    estimate: 3,
    labels: ['Documentation'],
  },
  {
    title: 'Archived: legacy CSV importer from v0.9',
    description: 'Superseded by the GitLab importer.',
    type: 'chore',
    priority: 'lowest',
    statusKey: 'closed',
    estimate: 5,
    labels: ['Technical debt'],
  },
  {
    title: 'Guest links should expire after 7 days by default',
    description: 'Currently every guest token is valid for 30 days unless explicitly configured.',
    type: 'feature',
    priority: 'medium',
    statusKey: 'backlog',
    estimate: 2,
    labels: ['Feature'],
  },
  {
    title: 'Kanban drag-and-drop loses position when two users move the same card',
    description:
      'Optimistic concurrency is enforced on the issue row but the board move path does not send\n' +
      '`expectedVersion`.',
    type: 'bug',
    priority: 'high',
    statusKey: 'blocked',
    assignee: 'dee',
    dueInDays: 2,
    estimate: 5,
    labels: ['Bug', 'Technical debt'],
  },
  {
    title: 'Burndown chart ignores issues resolved before the window start',
    description: 'The burndown widget starts from zero rather than the carried-over backlog.',
    type: 'bug',
    priority: 'low',
    statusKey: 'open',
    labels: ['Bug'],
  },
  {
    title: 'Login page is missing a password manager hint',
    description: 'Add a `new-password` autocomplete token and a visible password-visibility toggle.',
    type: 'task',
    priority: 'lowest',
    statusKey: 'closed',
    estimate: 1,
    labels: ['Good first issue'],
  },
  {
    title: 'Search: boolean operators are not highlighted in results',
    description: 'Users want to see which clause matched when they use `AND` / `OR` / `NEAR`.',
    type: 'feature',
    priority: 'medium',
    statusKey: 'open',
    assignee: 'ravi',
    dueInDays: 14,
    estimate: 3,
    labels: ['Feature'],
  },
  {
    title: 'Parent issue shows stale subtask progress',
    description:
      'The progress rollup on a parent issue does not refresh after a sub-task transitions.',
    type: 'bug',
    priority: 'high',
    statusKey: 'open',
    assignee: 'mo',
    dueInDays: 4,
    estimate: 3,
    labels: ['Bug'],
  },
];

function subtractHours(iso: string, hours: number): string {
  return new Date(new Date(iso).getTime() - hours * 3_600_000).toISOString();
}

export interface SeedResult {
  skipped: boolean;
  projectId?: number;
  userIds: Record<string, number>;
  issueCount: number;
}

/**
 * Populate a demo instance. Safe to call repeatedly: it returns early when the
 * demo admin already exists.
 */
export function seed(db: Database, services: Services): SeedResult {
  const existing = db.get<{ id: number }>('SELECT id FROM users WHERE username = ?', [DEMO_USERNAME]);
  if (existing) {
    return { skipped: true, userIds: {}, issueCount: 0 };
  }

  const userIds: Record<string, number> = {};

  db.transaction(() => {
    for (const user of USERS) {
      const id = Number(
        db.run(
          `INSERT INTO users
             (username, email, display_name, password_hash, provider, instance_role)
           VALUES (?,?,?,?,'local',?)`,
          [
            user.username,
            user.email,
            user.displayName,
            hashPassword(user.password),
            user.instanceRole,
          ],
        ).lastInsertRowid,
      );
      userIds[user.username] = id;
    }
  });

  const adminId = userIds['admin'] as number;
  const project = services.projects.create(
    {
      key: 'DEMO',
      name: 'Demo Project',
      description: 'A seeded project demonstrating the tracker end to end.',
      visibility: 'private',
      defaultIssueType: 'task',
      defaultPriority: 'medium',
      archivePolicy: { enabled: true, inactiveDays: 180, requireCommentWithinDays: 90 },
    },
    adminId,
    { ipAddress: 'seed', userAgent: 'seed-script' },
  );

  db.transaction(() => {
    for (const user of USERS) {
      if (user.username === 'admin') continue;
      db.run('INSERT INTO project_members (project_id, user_id, role) VALUES (?,?,?)', [
        project.id,
        userIds[user.username] as number,
        user.role,
      ]);
    }
  });

  const labels = new Map<string, number>();
  for (const label of services.projects.listLabels(project.id)) {
    labels.set(label.name, label.id);
  }

  const statuses = new Map<string, number>();
  for (const status of services.workflow.statusesForProject(project.id)) {
    statuses.set(status.key, status.id);
  }

  const createdIssueIds: number[] = [];

  for (const spec of ISSUES) {
    const statusId = statuses.get(spec.statusKey) ?? (statuses.get('open') as number);
    const createdAt = nowIso();

    services.issues.create(
      project.id,
      {
        title: spec.title,
        description: spec.description,
        type: spec.type,
        priority: spec.priority,
        statusId,
        assigneeId: spec.assignee ? (userIds[spec.assignee] ?? null) : null,
        dueDate:
          spec.dueInDays === undefined || spec.dueInDays === null
            ? null
            : addDays(createdAt, spec.dueInDays),
        estimateHours: spec.estimate ?? null,
        labelIds: (spec.labels ?? [])
          .map((name) => labels.get(name))
          .filter((id): id is number => id !== undefined),
      },
      userIds['ravi'] as number,
      { ipAddress: 'seed', userAgent: 'seed-script' },
    );

    // The service returns the issue; re-read the latest to keep the id in step.
    const latest = db.get<{ id: number }>(
      'SELECT id FROM issues WHERE project_id = ? ORDER BY id DESC LIMIT 1',
      [project.id],
    );
    if (latest) createdIssueIds.push(Number(latest.id));

    const issueId = createdIssueIds[createdIssueIds.length - 1] as number;

    // Backdate so the timeline and aging widgets have something to chew on.
    const ageDays = 1 + (createdIssueIds.length % 21);
    const created = addDays(createdAt, -ageDays);
    db.run('UPDATE issues SET created_at = ?, updated_at = ? WHERE id = ?', [
      created,
      subtractHours(createdAt, 2 + ageDays),
      issueId,
    ]);

    for (const child of spec.children ?? []) {
      const childStatusId = statuses.get(child.statusKey) ?? statusId;
      services.issues.create(
        project.id,
        { title: child.title, description: '', type: 'task', priority: 'medium', statusId: childStatusId },
        adminId,
        { ipAddress: 'seed', userAgent: 'seed-script' },
      );
      const childRow = db.get<{ id: number }>(
        'SELECT id FROM issues WHERE project_id = ? ORDER BY id DESC LIMIT 1',
        [project.id],
      );
      if (childRow) {
        db.run('UPDATE issues SET parent_id = ?, created_at = ?, updated_at = ? WHERE id = ?', [
          issueId,
          created,
          created,
          childRow.id,
        ]);
        // Keep the child's status consistent with the workflow it was created in.
        services.issues.transition(
          Number(childRow.id),
          { toStatusId: childStatusId },
          adminId,
          { ipAddress: 'seed' },
        );
      }
    }

    for (const comment of spec.comments ?? []) {
      const created = subtractHours(createdAt, comment.hoursAgo);
      services.comments.create(
        issueId,
        { body: comment.body },
        userIds[comment.author] ?? adminId,
        { silent: true },
      );
      const commentRow = db.get<{ id: number }>(
        'SELECT id FROM comments WHERE issue_id = ? ORDER BY id DESC LIMIT 1',
        [issueId],
      );
      if (commentRow) db.run('UPDATE comments SET created_at = ? WHERE id = ?', [created, commentRow.id]);
    }

    // Log a little time against the more substantial issues.
    if (spec.estimate && spec.estimate > 2) {
      db.run('UPDATE issues SET time_spent_hours = ? WHERE id = ?', [
        Math.max(0.5, spec.estimate / 3),
        issueId,
      ]);
    }
  }

  // Cross-issue links, applied after every issue exists.
  const linkSpecs: Array<{ from: number; to: number; kind: 'blocks' | 'relates_to' | 'duplicates' }> = [];
  for (let index = 0; index < ISSUES.length; index += 1) {
    for (const link of ISSUES[index]?.links ?? []) {
      const target = createdIssueIds[link.targetIndex];
      const source = createdIssueIds[index];
      if (target && source) linkSpecs.push({ from: source, to: target, kind: link.kind });
    }
  }
  // A realistic blocking relationship, since the per-issue spec did not need one.
  const boardBug = createdIssueIds[7];
  const ssoBug = createdIssueIds[0];
  if (boardBug && ssoBug) linkSpecs.push({ from: boardBug, to: ssoBug, kind: 'relates_to' });

  for (const link of linkSpecs) {
    try {
      services.issues.link(link.from, link.to, link.kind, adminId, { ipAddress: 'seed' });
    } catch {
      // A link that would create a cycle is simply not created; seeding should
      // not abort on a graph constraint.
    }
  }

  // An SLA policy so the countdown widget and alerting have data.
  try {
    services.sla.createPolicy(
      {
        projectId: project.id,
        name: 'Critical incident response',
        description: 'Acknowledge critical incidents within 30 minutes, resolve within 4 hours.',
        appliesTo: { types: ['incident', 'bug'], priorities: ['critical', 'highest'], labelIds: [], states: [] },
        responseMinutes: 30,
        resolutionMinutes: 240,
        warningMinutes: 15,
        businessHoursOnly: false,
        enabled: true,
      },
      { actorId: adminId },
    );
  } catch {
    // SLA seeding is best-effort.
  }

  for (const issueId of createdIssueIds) {
    try {
      services.sla.ensureClocksForIssue(issueId, { actorId: adminId });
    } catch {
      // Best effort.
    }
  }

  return { skipped: false, projectId: project.id, userIds, issueCount: createdIssueIds.length };
}

/** Run the seed as a standalone command. */
export async function main(): Promise<void> {
  const config = loadConfig();
  const db = new Database({ file: config.databaseFile, wal: false });
  migrate(db, { log: (message) => process.stdout.write(`  ${message}\n`) });

  const services = createServices({ config, db });
  const result = seed(db, services);

  if (result.skipped) {
    process.stdout.write('Seed skipped: the demo admin already exists.\n');
  } else {
    process.stdout.write(`Seeded project ${String(result.projectId)} with ${result.issueCount} issues.\n`);
    process.stdout.write(`Sign in as "${DEMO_USERNAME}" / "ChangeMe123!" and change the password.\n`);
  }

  db.close();
}

/**
 * Only run when invoked as a command (`npm run seed`), not when the module is
 * imported by a test.
 */
const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  main().catch((error: unknown) => {
    process.stderr.write(`Seed failed: ${error instanceof Error ? error.stack : String(error)}\n`);
    process.exit(1);
  });
}
