# Issue Tracker

A self-hosted, open source issue tracker with a **configurable GitLab source of
truth**, role-based dashboards, per-issue progress timelines, SLA countdowns and
a tamper-evident audit trail.

Zero-setup by design: it runs on Node's built-in SQLite, needs no Docker, no
external database and no native compilation.

```bash
git clone <your-repo-url> issue-tracker
cd issue-tracker
npm install
npm run migrate
npm run seed        # optional: a demo project with issues, comments and SLAs
npm run dev
```

Then open <http://localhost:4000>. The seeded demo account is
`admin` / `ChangeMe123!` — change it immediately.

---

## Table of contents

- [What it does](#what-it-does)
- [Architecture](#architecture)
- [Requirements coverage](#requirements-coverage)
- [GitLab integration](#gitlab-integration)
- [Getting started](#getting-started)
- [Configuration](#configuration)
- [API](#api)
- [Architecture notes](#architecture-notes)
- [Development](#development)
- [Security](#security)
- [Roadmap](#roadmap)
- [License](#license)

---

## What it does

**Issue lifecycle.** Full CRUD, per-project **customisable workflows** (statuses
plus the transitions permitted between them, with WIP limits), **parent/child
nesting** with cycle detection, and typed **dependencies** (`blocks`,
`is_blocked_by`, `duplicates`, `relates_to`, `caused_by`, …) with blocking-cycle
prevention.

**Collaboration.** Rich-text (Markdown) comment logs, `@mentions` that resolve
only to users who can actually see the issue, multi-format file attachments
(logs, screenshots, PDFs) with content-addressed storage and magic-byte
verification, watchers, and notifications delivered both in-app and through a
durable email outbox.

**Access and security.** Six built-in roles (`owner`, `admin`, `maintainer`,
`developer`, `reporter`, `viewer`) behind a single capability-based permission
check, multi-project membership, time-bound guest access tokens, and an
**immutable audit trail** whose entries are hash-chained and rejected at the
database level if anyone tries to edit them.

**Analytics and search.** SQLite FTS5 full-text search with field filters,
custom saved filters, JSON/CSV/Markdown export, role-scoped **customisable
dashboards** with 16 widget types, SLA policies with live countdowns and
breach alerts, and outgoing signed webhooks.

**Nice to have, included.** Bulk issue editing, automated stale-issue
archiving, duplicate detection, interactive Kanban boards, real-time
co-authoring presence, and automatic PII/secret scrubbing.

---

## Architecture

```
issue-tracker/
├── packages/
│   ├── shared/     @tracker/shared — domain types, zod schemas, RBAC rules
│   ├── server/     @tracker/server — Fastify API, SQLite, background jobs
│   └── web/        @tracker/web — React + Vite SPA
└── docs/
    └── foundation.md   the contract every module builds against
```

The whole stack is TypeScript with **one shared type package**. A workflow
transition rule or a GitLab sync-mode change cannot drift between the API and the
UI, because both import the same declaration.

```
packages/server/src/
├── app.ts              Fastify assembly, route ordering, error handling
├── config.ts           environment resolution, per-install secret generation
├── db/
│   ├── connection.ts   prepared-statement cache, re-entrant transactions
│   ├── migrate.ts      checksummed forward-only migrations
│   └── migrations/     the authoritative schema
├── services/           one file per bounded concern
│   ├── issue.service.ts    lifecycle, nesting, dependencies, board projection
│   ├── workflow.service.ts transition rules, WIP limits, timing stamps
│   ├── project.service.ts  creation fan-out, membership, labels, milestones
│   ├── audit.service.ts    hash-chained append-only trail
│   ├── activity.service.ts per-issue timeline events
│   ├── gitlab/             adapter + configurable source-of-truth sync engine
│   └── …                   search, bulk, export, dedupe, sla, dashboards, webhooks
├── realtime/           WebSocket gateway and the presence table
├── routes/             HTTP surface
└── jobs/               scheduler: SLA evaluation, archiving, sync, outbox
```

### Why SQLite

Node 24 ships `node:sqlite`, including **FTS5**, so full-text search works with
no native module to compile. Every query goes through `db/connection.ts`, which
caches prepared statements, enables foreign keys and WAL, and makes transactions
re-entrant so nested service calls join the outer transaction instead of
failing.

The data layer sticks to portable SQL. The one SQLite-specific construct,
`INTEGER PRIMARY KEY AUTOINCREMENT`, is isolated to the migration files — moving
to Postgres means reinterpreting two lines, not rewriting every query.

---

## Requirements coverage

### Issue lifecycle

| Requirement | Status | Where |
| --- | --- | --- |
| CRUD ticket operations | ✅ | `services/issue.service.ts` |
| Customisable workflows | ✅ | `services/workflow.service.ts` — per-project statuses + transitions + WIP limits |
| `Open → In Progress → Closed` | ✅ | Default workflow, seeded per project |
| Parent/child ticket nesting | ✅ | `parentId`, cycle detection on both write and re-parent |
| Dependencies | ✅ | 10 link kinds; blocking cycles rejected |
| Bulk issue editing | ✅ | `services/bulk.service.ts` — 13 operations, per-row error isolation |
| Automated stale-issue archiving | ✅ | `services/archive.service.ts` — preview, policy, idempotent run |
| AI-driven duplicate detection | ✅ | `services/dedupe.service.ts` — see the note below |

> **On "AI-driven" duplicate detection.** There is no external model available in
> this environment, so the detector is a **deterministic local similarity
> engine**: exact normalised-title matching, a Jaccard + trigram-Dice fuzzy
> score, and a feature-hashed cosine "semantic" strategy. The `semantic` strategy
> is a *lexical proxy, not a neural embedding*, and the code says so. All three
> implement one `SimilarityStrategy` interface, so a real encoder can be dropped
> in without touching the scan pipeline. Replace it with a real embedding
> provider before relying on it for large projects.

### Collaboration

| Requirement | Status | Where |
| --- | --- | --- |
| Rich-text comment logs | ✅ | Markdown bodies, edited/deleted tracked on the timeline |
| @mentions | ✅ | Resolved to users who can see the issue; unknown handles stay literal |
| Multi-format attachments | ✅ | SHA-256 content-addressed blobs, MIME allow-list, magic-byte check, traversal defence. SVG is refused — see [Security](#security) |
| Automated email/system notifications | ✅ | 16 event types, per-user preferences, durable `email_outbox` drained over SMTP or a relay webhook |
| Interactive Kanban boards | ✅ | Fractional positions, optimistic moves, WIP badges |
| Real-time co-authoring presence | ✅ | `realtime/gateway.ts`, heartbeat + pruning |
| Built-in video recording | ✅ | Browser `MediaRecorder` capture, review-before-attach, inline playback (`VideoRecorder.tsx`) |

### Access and security

| Requirement | Status | Where |
| --- | --- | --- |
| RBAC | ✅ | Six roles → capability grants → one `can()` check |
| Multi-project permissions | ✅ | Per-project membership with rank-safe role changes |
| SSO / SAML | ❌ | **Deliberately not implemented.** Verification code existed and asserted signatures before reading any claim, but configurations could only be listed — never created, edited or deleted, at either the route or service layer — so a deployment had to write to `sso_configurations` by hand. A feature you cannot configure is worse than its absence, so it was removed rather than shipped half-reachable. The table and all code are gone (migration `005_drop_sso.sql`). |
| Immutable audit trails | ✅ | Hash-chained rows + `BEFORE UPDATE`/`BEFORE DELETE` triggers that `RAISE(ABORT)` |
| Time-bound guest access tokens | ✅ | Expiry, max-use, project scope, optional issue scope, revoke |
| Biometric mobile app login | ⚠️ | **Partially met.** Passkeys via WebAuthn give Face ID / Touch ID / fingerprint sign-in in any browser, and that is fully implemented. The literal requirement — a *mobile app* that authenticates biometrically — is **not** met: this project ships no native app. |
| Automatic PII/secret scrubbing | ✅ | `scrubSecrets()` — 11 credential patterns + configurable extras |

### Analytics and technology

| Requirement | Status | Where |
| --- | --- | --- |
| Full-text search queries | ✅ | FTS5 over issues and comments, with bm25 ranking |
| Custom filtering | ✅ | 20 filter dimensions, keyset pagination |
| Data export | ✅ | JSON, RFC-4180 CSV, Markdown |
| Git version-control linkages | ✅ | `project_repositories` + `issue_references`; branches/commits/MRs per issue, with naming-rule auto-linking |
| Custom metric dashboard widgets | ✅ | 16 widget types, drag-to-arrange grid |
| SLA breach countdown timers | ✅ | Response + resolution clocks, business-hours aware |
| Live webhook message broadcasting | ✅ | Signed outbound deliveries, retries, auto-disable |

---

## GitLab integration

The product decision this was built around: **you choose which side is the source
of truth.** A connection declares a `SyncMode`, and all three modes run through
one adapter — only the conflict-resolution rule differs.

| Mode | Behaviour |
| --- | --- |
| `local_authoritative` | This tracker is canonical. Edits are pushed to GitLab; edits made directly in GitLab are imported and recorded as conflicts rather than silently discarded. |
| `gitlab_authoritative` | GitLab is canonical. Local edits are pushed immediately so GitLab stays canonical; overwritten local values are recorded as conflicts. |
| `bidirectional` | Both accept writes. The newer `updated_at` wins; a tie within 2 s goes to GitLab. Anything non-automatic is recorded as a conflict for human review. |

**A sync never silently discards data on either side.** Every disagreement is
written to `gitlab_sync_conflicts` with both values and both timestamps, and
surfaced in the Settings → GitLab panel where you resolve it — keep mine, keep
GitLab, or merge.

### Preventing sync loops

Two mechanisms, because a naive mirror ping-pongs forever:

- **Priority** rides in a reserved `priority::<name>` label, stripped from the
  visible label list on import.
- **No-op suppression** — the pushed payload is hashed into
  `last_pushed_hash`, so an unchanged push is skipped entirely and never bumps
  GitLab's `updated_at`. Without this, every sync would make the next sync
  think something changed.

Pushed notes carry an `<!-- tracker:KEY -->` marker; any note bearing a marker is
never re-imported, and pushed-note dedup is by exact body.

### Round-trip tripwires

Priority labels, title prefixes, comment markers, hierarchy mapping and label
normalisation are each verified by a round-trip test in
`test/gitlab.test.ts`, which drives a real HTTP server speaking the GitLab v4 API.
That is deliberate: a mocked client will happily agree with a mis-shaped
request, which is exactly the class of bug that turns a sync into data loss.

---

## Getting started

**Requirements:** Node 22.5+ (developed on 24). That is the whole list.

```bash
npm install          # installs all three workspaces
npm run migrate      # create the SQLite database and apply migrations
npm run seed         # optional demo data
npm run dev          # API on :4000, Vite dev server on :5173
```

Production:

```bash
npm run build        # compile shared -> server -> web
npm start            # API serves the built SPA from a single process
```

Other commands:

```bash
npm test             # server test suite
npm run typecheck    # strict typecheck across all workspaces
npm run migrate -- status   # show applied and pending migrations
```

### Creating the first admin

The first registered account becomes an instance administrator automatically.
For a non-interactive setup:

```bash
BOOTSTRAP_ADMIN_EMAIL=admin@acme.com \
BOOTSTRAP_ADMIN_PASSWORD='a-strong-initial-password' \
npm start
```

### Working on the code

```bash
npm run dev:server   # API with file watching
npm run dev:web      # Vite dev server, proxying /api and /ws to :4000
```

Read [`docs/foundation.md`](docs/foundation.md) before adding a service or a
route. It documents the database contract, the error model, the auditing rules
and the conventions every module follows, so new work composes with the existing
subsystems instead of reinventing them.

---

## Configuration

Everything has a working default; set only what you need.

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `4000` | HTTP port |
| `HOST` | `0.0.0.0` | Bind address |
| `NODE_ENV` | `development` | `development` \| `test` \| `production` |
| `DATA_DIR` | `./data` | Database, uploads, generated secrets |
| `DATABASE_FILE` | `<DATA_DIR>/tracker.db` | SQLite path |
| `MAX_UPLOAD_BYTES` | `26214400` | Upload limit (25 MB) |
| `SESSION_TTL_SECONDS` | `604800` | Session lifetime (7 days) |
| `CORS_ORIGINS` | *(reflect origin)* | Comma-separated allow-list |
| `SERVE_WEB_CLIENT` | `true` | Serve the built SPA from the API |
| `WEB_CLIENT_DIR` | `../web/dist` | Built SPA location |
| `ENABLE_SCHEDULER` | `true` | Background jobs (off in tests) |
| `TRUST_PROXY` | `false` | Honour `X-Forwarded-*` |
| `WEBHOOK_ALLOW_PRIVATE_TARGETS` | `false` | Permit webhook targets on loopback/private addresses |
| `LOG_LEVEL` | `info` | Pino log level |
| `BOOTSTRAP_ADMIN_EMAIL` / `_PASSWORD` | — | Seed an admin on first boot |

### Outbound email

Notifications queue in `email_outbox` and a background job drains them. With
nothing configured they simply accumulate — in-app and WebSocket notifications
are unaffected.

| Variable | Default | Purpose |
| --- | --- | --- |
| `SMTP_HOST` | — | Enables the SMTP transport |
| `SMTP_PORT` | `587` | `465` implies implicit TLS |
| `SMTP_SECURE` | `false` | Force implicit TLS on another port |
| `SMTP_USERNAME` / `SMTP_PASSWORD` | — | AUTH LOGIN credentials |
| `MAIL_WEBHOOK_URL` | — | POST each message to a relay instead |
| `MAIL_WEBHOOK_SECRET` | — | Sent as a bearer token to that relay |
| `MAIL_FROM` / `MAIL_FROM_NAME` | `tracker@localhost` | Envelope sender |
| `MAIL_MAX_ATTEMPTS` | `5` | Attempts before a row is parked as `failed` |

STARTTLS is only attempted when the server advertises it, and **credentials are
refused outright** rather than sent over an unencrypted channel.

### Outgoing webhooks

Webhook targets are refused if they point at a loopback, private, link-local or
reserved address, at registration **and** again at delivery after DNS
resolution — the second check is what stops a hostname that is public when you
register it and private by the time the event fires. This is a server-side
request forgery defence: the *server* makes the request, so an internal target
would otherwise hand a `webhook.manage` holder a route to this tracker's own
admin API and, on a cloud host, to the instance metadata service that returns
IAM credentials. Targets are also checked for a non-http scheme and for embedded
credentials.

Set `WEBHOOK_ALLOW_PRIVATE_TARGETS=true` if you genuinely deliver to an
internal service.

### Passkeys

Passkeys are the browser-native form of biometric login: the user approves with
Face ID, Touch ID or a fingerprint, and the private key stays in the device's
secure element. Nothing to configure — the relying-party id is derived from
`PUBLIC_URL`.

| Variable | Default | Purpose |
| --- | --- | --- |
| `WEBAUTHN_RP_ID` | host of `PUBLIC_URL` | Overrides the relying-party id |
| `WEBAUTHN_RP_NAME` | `Issue Tracker` | Shown in the platform prompt |
| `WEBAUTHN_EXTRA_ORIGINS` | — | Comma-separated extra origins (e.g. a webview) |

The encryption key and session secret are **generated and persisted** to
`DATA_DIR/.secrets.json` on first run (mode `0600`), so a fresh clone starts
immediately without shipping a hard-coded key, and restarting does not
invalidate sessions or orphan encrypted GitLab tokens. Back up that file — losing
it makes stored integration tokens unrecoverable.

### Migrations

Migrations are plain SQL applied in filename order and recorded with a SHA-256
checksum. Editing a migration that has already run is a **hard error** on
startup, not a silent re-run:

```
Migration 001_init.sql was modified after it was applied
(recorded a1b2c3…, found 9f8e7d…). Add a new migration instead.
```

---

## API

Paths are pinned in `@tracker/shared` as the `API` constant, so the server and
the client cannot drift.

```
POST   /api/auth/register            GET  /api/auth/me
POST   /api/auth/login               POST /api/auth/logout
POST   /api/projects                 GET  /api/projects
GET    /api/projects/:id             PATCH /api/projects/:id
GET    /api/projects/:id/workflow    PUT  /api/projects/:id/workflow
GET    /api/projects/:id/board       POST /api/projects/:id/board/move
GET    /api/issues/search            POST /api/issues
GET    /api/issues/:id               PATCH /api/issues/:id
POST   /api/issues/:id/transition    GET  /api/issues/:id/timeline
GET    /api/issues/:id/timing        GET  /api/issues/:id/sla
GET    /api/issues/:id/links         POST /api/issues/:id/links
GET    /api/issues/:id/comments      POST /api/issues/:id/comments
GET    /api/dashboards/visible       GET  /api/dashboards/:id/render
GET    /api/sla/policies             GET  /api/sla/at-risk
GET    /api/projects/:id/gitlab      POST /api/projects/:id/gitlab/sync
GET    /api/projects/:id/gitlab/conflicts
POST   /api/gitlab/test              POST /webhooks/gitlab/:secret
GET    /api/admin/audit              GET  /api/admin/audit/verify
WS     /ws                           ← Kanban, presence, live notifications
```

Errors always use one envelope, so clients can branch on a stable code rather
than parsing prose:

```json
{
  "error": {
    "code": "validation_failed",
    "message": "The request body failed validation",
    "fields": [{ "path": "title", "message": "String must contain at least 1 character(s)" }],
    "requestId": "req-7"
  }
}
```

Codes: `bad_request`, `validation_failed`, `unauthenticated`, `forbidden`,
`not_found`, `conflict`, `version_conflict`, `rate_limited`, `payload_too_large`,
`unsupported_media`, `workflow_violation`, `cycle_detected`,
`immutable_violation`, `integration_error`, `sync_conflict`, `internal_error`.

Internal error messages and SQL never reach a client; unexpected failures are
logged with their stack and reported as an opaque `internal_error`.

### Authentication

Sessions are `httpOnly` `SameSite=Lax` cookies. For scripts and CI, mint an API
token (`POST /api/users/me/tokens`) and send `Authorization: Bearer <token>`;
tokens are stored hashed and the secret is returned exactly once.

---

## Architecture notes

Decisions worth knowing before changing the code.

**Optimistic concurrency.** Every issue carries a `version`. A client that read
v3 and writes `expectedVersion: 3` succeeds; if someone else wrote in between it
gets a `409 version_conflict` instead of silently clobbering the edit.

**One write path, many side effects.** Each mutation writes exactly one activity
event, one audit entry, publishes the realtime event, and notifies where a
downstream system cares. That agreement is what keeps the timeline, the audit
trail and the Kanban board from contradicting each other.

**Hash-chained audit trail.** Each row stores the SHA-256 of its own canonical
contents plus the previous row's hash. The schema refuses `UPDATE` and `DELETE`
outright, and `GET /api/admin/audit/verify` recomputes the entire chain —
`test/audit.test.ts` drops a trigger to simulate an attacker and asserts the
tampering is detected, so the guarantee is proven rather than asserted.

**Ownership never widens a permission.** `comment.update.any` is not silently
downgraded to `comment.update.own` when the actor happens to own the resource;
a caller must ask for the `*.own` variant explicitly. A regression test covers
this, because the alternative let a reporter edit other people's comments.

**Kanban positions are floats.** Dropping a card between two others writes the
midpoint, so a move never renumbers the column. Ties are nudged apart.

**Cycle prevention is structural.** Re-parenting walks the ancestor chain;
blocking links walk the existing blocking graph. Both have regression tests,
including the negative case.

**SQL is always parameterised.** Only placeholder *counts* are interpolated, via
`placeholders()` / `inClause()`. Batch projections build a dynamic `WHERE` but
bind every value.

> A note learned the hard way: SQLite compares a `TEXT` column against a bound
> number by applying the column's affinity, so `entity_id = ?` with a JS number
> silently does not match a stored `'3'`. Bind strings for text columns.

---

## Development

```
packages/server/test/
├── helpers.ts             per-test in-memory database and fixtures
├── rbac.test.ts           permission matrix, ownership fallback
├── audit.test.ts          hash chain, immutability, tamper detection
├── crypto-time.test.ts    password hashing, tokens, encryption, scrubbing
├── issue.test.ts          lifecycle, nesting cycles, dependencies, board
├── workflow.test.ts       transition rules, WIP limits, timing stamps
├── versioncontrol.test.ts branch naming rules, reference ownership
├── mail.test.ts           message construction, SMTP round trip
├── webauthn.test.ts       challenge lifecycle, cloning, lockout
├── gitlab.test.ts         source-of-truth modes, conflict resolution, loops
├── realtime.test.ts       hub fan-out, presence isolation, live WebSocket
├── contract.test.ts       every declared route constant is actually routed
├── migration.test.ts      upgrade path from a previously-migrated database
├── search.test.ts         FTS queries, filters, export
├── dedupe.test.ts         duplicate scoring and dismissal
├── sla.test.ts            clock settlement, breach, at-risk windows
├── timing.test.ts         durations, overdue baseline, sub-task rollup
├── dashboards.test.ts     role-scoped widgets and rendering
├── collaboration.test.ts  comments, mentions, attachments, search filters
├── attachment.test.ts     upload limits, traversal, content sniffing
├── webhook.test.ts        SSRF defence, signatures, retry, auto-disable
├── services.test.ts       project, member and guest-token rules
└── api.test.ts            end-to-end over HTTP
```

Every test gets its own in-memory database, so suites are isolated and can run
concurrently. CI runs `typecheck`, `test` and a production `build`.

### Contributor rules

- Relative imports use the **`.ts` extension** (`import { x } from './y.ts'`).
  `tsconfig` rewrites them to `.js` on emit. Do not use `.js` — Node's type
  stripping does not remap, and the dev server will not resolve them.
- No enums, namespaces or **parameter properties**; the code must run under
  Node's type stripping (`--experimental-strip-types`).
- Strict TypeScript, `noUncheckedIndexedAccess`. No `any` without a comment
  explaining why.
- Every state change records an audit entry; user-visible changes also append an
  activity event.
- Every SQL value is bound.

---

## Security

- Passwords hashed with **scrypt** (N=16384) using Node's standard library —
  memory-hard, no native dependency. Parameters travel with the hash so they can
  be raised without invalidating existing accounts.
- API tokens and guest tokens stored as SHA-256 hashes; secrets shown once.
- Integration tokens encrypted at rest with **AES-256-GCM** under a
  per-installation key. They are never returned by the API, never logged, and
  redacted out of error messages. Log redaction covers
  `authorization`, `cookie`, `password`, `token` and `clientSecret`.
- Uploads: server-generated content-addressed names (removing the path-traversal
  class), MIME allow-list, magic-byte verification, and a re-check that the
  resolved path stays inside the upload root.
- **SVG is refused as an upload type.** It is a script-execution vector: an
  uploaded one opened from disk runs in a `file://` origin. Screenshots upload
  as PNG or WebP.
- Webhook deliveries are signed; inbound GitLab webhooks are verified in
  constant time and de-duplicated by event id so retries cannot double-apply.
- Login is rate-limited per IP; a global limiter backs everything else.
- The GitLab token form only accepts `https://` (except localhost), so a
  credential cannot be sent in the clear.

### Known gaps

- **Instance settings are environment-driven only.** There is no
  `/api/admin/settings` route, so configuration is edited in the environment
  rather than from the product.
- **10 declared contract entries have no route.** `@tracker/shared` promises
  more surface than the server implements. The list is asserted in
  `packages/server/test/contract.test.ts` as an explicit, commented allowlist
  so the gap is tracked and new drift fails CI. The substantive ones are
  per-status and per-transition workflow CRUD (the whole workflow is `PUT` as
  one document instead), and an instance-wide admin user list.
- The bundled SMTP client speaks only submission: it will not act as a
  receiving server, and it negotiates STARTTLS rather than exotic extensions.
  With no `SMTP_*` or `MAIL_WEBHOOK_URL` set, notifications stay in
  `email_outbox` with the reason recorded, and are delivered once a transport
  is configured. In-app notifications and the WebSocket channel work either way.
- Duplicate detection is lexical, not semantic (see above).
- No rate limiting per API token, only per IP.
- Single sign-on was removed on purpose, not by oversight. See the Access and
  security table above.

---

## Roadmap

Deliberately not built yet, in rough priority order:

- **A native mobile app.** The "biometric mobile app login" requirement is only
  partially met: WebAuthn passkeys give Face ID / Touch ID / fingerprint
  sign-in in any browser, but there is no native app and therefore no in-app
  biometric API.
- **Video recording with audio across every browser** — capture, review and
  inline playback all work, but `getDisplayMedia` audio is Chromium-only, and
  there is no transcription or playback-speed control.
- **A real embedding model** behind the duplicate-detection interface.
- **Postgres adapter** — the query layer is deliberately portable.
- **Instance settings and per-user dashboard layouts**, saved searches, and an
  admin user list.
- **Single sign-on**, if it is ever wanted again — it would need configuration
  CRUD to exist at all, not just verification.

---

## License

MIT — see [LICENSE](LICENSE).
