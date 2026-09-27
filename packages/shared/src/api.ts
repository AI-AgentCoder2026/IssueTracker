/**
 * HTTP contract.
 *
 * Route paths live here so the API and the web client cannot drift apart: both
 * sides import these constants instead of repeating string literals. Path
 * parameters are written with Fastify's `:name` syntax; `fill()` substitutes
 * them and URL-encodes the values.
 */

/** Substitute `:param` segments and encode each value. */
export function fill(template: string, params: Record<string, string | number> = {}): string {
  return template.replace(/:([A-Za-z0-9_]+)/g, (_match, key: string) => {
    const value = params[key];
    if (value === undefined) {
      throw new Error(`Missing route parameter "${key}" for template "${template}"`);
    }
    return encodeURIComponent(String(value));
  });
}

export const API = {
  // -- auth & users --------------------------------------------------------
  auth: {
    register: '/api/auth/register',
    login: '/api/auth/login',
    logout: '/api/auth/logout',
    me: '/api/auth/me',
    changePassword: '/api/auth/password',
    ssoProviders: '/api/auth/sso/providers',
    ssoStart: '/api/auth/sso/:provider/start',
    ssoCallback: '/api/auth/sso/:provider/callback',
    guestRedeem: '/api/auth/guest/redeem',
  },
  users: {
    list: '/api/users',
    get: '/api/users/:id',
    create: '/api/users',
    update: '/api/users/:id',
    deactivate: '/api/users/:id/deactivate',
    tokens: '/api/users/me/tokens',
    createToken: '/api/users/me/tokens',
    revokeToken: '/api/users/me/tokens/:id',
    guestTokens: '/api/projects/:projectId/guest-tokens',
    createGuestToken: '/api/projects/:projectId/guest-tokens',
    revokeGuestToken: '/api/projects/:projectId/guest-tokens/:id',
  },

  // -- projects & members --------------------------------------------------
  projects: {
    list: '/api/projects',
    create: '/api/projects',
    get: '/api/projects/:projectId',
    update: '/api/projects/:projectId',
    remove: '/api/projects/:projectId',
    members: '/api/projects/:projectId/members',
    addMember: '/api/projects/:projectId/members',
    updateMember: '/api/projects/:projectId/members/:userId',
    removeMember: '/api/projects/:projectId/members/:userId',
    roles: '/api/projects/:projectId/roles',
    labels: '/api/projects/:projectId/labels',
    createLabel: '/api/projects/:projectId/labels',
    updateLabel: '/api/projects/:projectId/labels/:id',
    removeLabel: '/api/projects/:projectId/labels/:id',
    milestones: '/api/projects/:projectId/milestones',
    createMilestone: '/api/projects/:projectId/milestones',
    updateMilestone: '/api/projects/:projectId/milestones/:id',
    removeMilestone: '/api/projects/:projectId/milestones/:id',
    stats: '/api/projects/:projectId/stats',
  },

  // -- workflow ------------------------------------------------------------
  workflow: {
    get: '/api/projects/:projectId/workflow',
    update: '/api/projects/:projectId/workflow',
    statuses: '/api/projects/:projectId/workflow/statuses',
    createStatus: '/api/projects/:projectId/workflow/statuses',
    updateStatus: '/api/projects/:projectId/workflow/statuses/:id',
    removeStatus: '/api/projects/:projectId/workflow/statuses/:id',
    transitions: '/api/projects/:projectId/workflow/transitions',
    createTransition: '/api/projects/:projectId/workflow/transitions',
    removeTransition: '/api/projects/:projectId/workflow/transitions/:id',
  },

  // -- issues --------------------------------------------------------------
  issues: {
    list: '/api/issues',
    create: '/api/issues',
    search: '/api/issues/search',
    get: '/api/issues/:issueId',
    update: '/api/issues/:issueId',
    remove: '/api/issues/:issueId',
    transition: '/api/issues/:issueId/transition',
    availableTransitions: '/api/issues/:issueId/transitions',
    link: '/api/issues/:issueId/links',
    unlink: '/api/issues/:issueId/links/:linkId',
    children: '/api/issues/:issueId/children',
    ancestors: '/api/issues/:issueId/ancestors',
    timeline: '/api/issues/:issueId/timeline',
    timing: '/api/issues/:issueId/timing',
    logTime: '/api/issues/:issueId/time',
    watch: '/api/issues/:issueId/watch',
    unwatch: '/api/issues/:issueId/watch',
    archive: '/api/issues/:issueId/archive',
    duplicates: '/api/issues/:issueId/duplicates',
    // Comments / attachments / references are nested under the issue.
    comments: '/api/issues/:issueId/comments',
    createComment: '/api/issues/:issueId/comments',
    updateComment: '/api/comments/:commentId',
    removeComment: '/api/comments/:commentId',
    attachments: '/api/issues/:issueId/attachments',
    upload: '/api/issues/:issueId/attachments',
    attachmentDownload: '/api/attachments/:id',
    removeAttachment: '/api/attachments/:id',
    // Version-control linkage.
    references: '/api/issues/:issueId/references',
    addReference: '/api/issues/:issueId/references',
    updateReference: '/api/issues/:issueId/references/:id',
    removeReference: '/api/issues/:issueId/references/:id',
    linkageSummary: '/api/issues/:issueId/linkage',
  },

  // -- version control ----------------------------------------------------
  versionControl: {
    repositories: '/api/projects/:projectId/repositories',
    createRepository: '/api/projects/:projectId/repositories',
    removeRepository: '/api/projects/:projectId/repositories/:id',
    /** Project-wide view of every linked artefact. */
    projectReferences: '/api/projects/:projectId/references',
    branchRules: '/api/projects/:projectId/repositories/:id/branch-rules',
    createBranchRule: '/api/projects/:projectId/repositories/:id/branch-rules',
    removeBranchRule: '/api/projects/:projectId/repositories/:id/branch-rules/:ruleId',
    importBranches: '/api/projects/:projectId/repositories/:id/branches/import',
  },

  // -- board ---------------------------------------------------------------
  board: {
    get: '/api/projects/:projectId/board',
    move: '/api/projects/:projectId/board/move',
  },

  // -- bulk, search, export ------------------------------------------------
  bulk: {
    edit: '/api/issues/bulk',
    apply: '/api/issues/bulk',
  },
  export: {
    run: '/api/export',
  },
  dedupe: {
    scan: '/api/dedupe/scan',
    candidates: '/api/dedupe/candidates',
    dismiss: '/api/dedupe/candidates/:linkId',
  },
  archive: {
    policy: '/api/archive/policy',
    run: '/api/archive/run',
    candidates: '/api/archive/candidates',
  },

  // -- dashboards ----------------------------------------------------------
  dashboards: {
    list: '/api/dashboards',
    create: '/api/dashboards',
    visible: '/api/dashboards/visible',
    get: '/api/dashboards/:id',
    update: '/api/dashboards/:id',
    remove: '/api/dashboards/:id',
    widgets: '/api/dashboards/:id/widgets',
    addWidget: '/api/dashboards/:id/widgets',
    updateWidget: '/api/dashboards/:id/widgets/:widgetId',
    removeWidget: '/api/dashboards/:id/widgets/:widgetId',
    render: '/api/dashboards/:id/render',
    reorder: '/api/dashboards/:id/widgets/reorder',
  },

  // -- SLA -----------------------------------------------------------------
  sla: {
    policies: '/api/sla/policies',
    createPolicy: '/api/sla/policies',
    updatePolicy: '/api/sla/policies/:id',
    removePolicy: '/api/sla/policies/:id',
    forIssue: '/api/issues/:issueId/sla',
    atRisk: '/api/sla/at-risk',
    breached: '/api/sla/breached',
  },

  // -- webauthn / passkeys -------------------------------------------------
  webauthn: {
    registerBegin: '/api/webauthn/register/begin',
    registerFinish: '/api/webauthn/register/finish',
    authenticateBegin: '/api/webauthn/authenticate/begin',
    authenticateFinish: '/api/webauthn/authenticate/finish',
    credentials: '/api/webauthn/credentials',
    revokeCredential: '/api/webauthn/credentials/:id',
    revokeAll: '/api/webauthn/credentials/revoke-all',
  },

  // -- notifications -------------------------------------------------------
  notifications: {
    list: '/api/notifications',
    markRead: '/api/notifications/read',
    markAllRead: '/api/notifications/read-all',
    preferences: '/api/notifications/preferences',
  },

  // -- gitlab --------------------------------------------------------------
  gitlab: {
    test: '/api/gitlab/test',
    connections: '/api/projects/:projectId/gitlab',
    connection: '/api/projects/:projectId/gitlab',
    update: '/api/projects/:projectId/gitlab',
    remove: '/api/projects/:projectId/gitlab',
    sync: '/api/projects/:projectId/gitlab/sync',
    runs: '/api/projects/:projectId/gitlab/sync-runs',
    conflicts: '/api/projects/:projectId/gitlab/conflicts',
    resolveConflict: '/api/gitlab/conflicts/:id/resolve',
    // Inbound receiver; the path includes the per-connection secret.
    inbound: '/webhooks/gitlab/:secret',
    status: '/api/projects/:projectId/gitlab/status',
  },

  // -- outgoing webhooks ---------------------------------------------------
  webhooks: {
    list: '/api/projects/:projectId/webhooks',
    create: '/api/projects/:projectId/webhooks',
    update: '/api/projects/:projectId/webhooks/:id',
    remove: '/api/projects/:projectId/webhooks/:id',
    deliveries: '/api/projects/:projectId/webhooks/:id/deliveries',
    test: '/api/projects/:projectId/webhooks/:id/test',
  },

  // -- admin ---------------------------------------------------------------
  admin: {
    users: '/api/admin/users',
    ssoConfigurations: '/api/admin/sso',
    createSso: '/api/admin/sso',
    updateSso: '/api/admin/sso/:id',
    removeSso: '/api/admin/sso/:id',
    auditLog: '/api/admin/audit',
    verifyAuditChain: '/api/admin/audit/verify',
    settings: '/api/admin/settings',
    updateSettings: '/api/admin/settings',
    health: '/api/health',
  },
} as const;

export { WS_PATH } from './realtime.ts';
