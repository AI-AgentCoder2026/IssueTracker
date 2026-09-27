# Contributing

Thanks for considering this. It is a young project, so a small, focused pull
request that is easy to review is worth far more than a large one.

## Before you start

- **Open an issue first** for anything beyond a trivial fix, so we can agree on
  the approach before you spend an evening on it.
- Check the [Roadmap](README.md#roadmap) — if it is listed as "not built", open
  an issue before implementing it.
- If you are unsure whether a change belongs, ask. A two-line comment is cheaper
  than a rejected pull request.

## Getting set up

You need **Node 22.5 or newer** (24 is what CI uses). That is the only
prerequisite — the database is SQLite via Node's built-in `node:sqlite`, so there
is nothing to install, no Docker and no native compilation.

```bash
git clone <your-fork-url> issue-tracker
cd issue-tracker
npm install
npm run migrate
npm run seed        # optional: a demo project with issues and comments
npm run dev
```

The web client runs on <http://localhost:5173> with API proxying to
<http://localhost:4000>.

## The rules that will bite you

These are not style preferences. Each one exists because breaking it causes a
specific failure.

### Relative imports use the `.ts` extension

```ts
import { AppError } from '../errors.ts';   // yes
import { AppError } from '../errors.js';   // no
```

`tsconfig` has `allowImportingTsExtensions` and `rewriteRelativeImportExtensions`,
so `tsc` rewrites `.ts` to `.js` on emit. Writing `.js` breaks the dev server,
which runs straight from source under Node's type stripping and does **not**
remap `.js` back to `.ts`.

### No enums, namespaces or parameter properties

```ts
// no
constructor(private readonly db: Database) {}

// yes
private readonly db: Database;
constructor(db: Database) { this.db = db; }
```

The same type-stripping constraint. `enum` and parameter properties are not
erasable syntax and will not run.

### Every SQL value is bound

Only placeholder *counts* may be interpolated:

```ts
const slots = placeholders(ids.length);          // fine
db.all(`SELECT * FROM issues WHERE id IN (${slots})`, ids);   // fine
db.all(`SELECT * FROM issues WHERE id IN (${ids.join(',')})`); // never
```

There is a second trap worth knowing: SQLite compares a `TEXT` column against a
bound *number* by applying the column's affinity, so `entity_id = ?` with a JS
number silently fails to match a stored `'3'`. Bind strings for text columns.

### Every state change is audited

If a service method writes to a table, it records an `audit_log` entry, and if
users can see the change it also appends an `activity_events` row. That is what
keeps the timeline, the audit trail and the board in agreement.

`audit_log` is append-only and hash-chained: the schema has triggers that reject
`UPDATE` and `DELETE`. Never try to "fix" a historical row.

### Shared rules live in `@tracker/shared`

If a rule can differ between server and client, it belongs in
`packages/shared` — the RBAC matrix, the workflow model, the GitLab sync modes,
and the HTTP paths in `api.ts`. Routes import `API` and `fill()`; they never
write a URL string. That is what stops the client's API layer from drifting.

## Working on the code

Read [`docs/foundation.md`](docs/foundation.md) first. It documents the database
contract, the error model, the auditing rules and the conventions every module
follows.

```bash
npm test                    # the whole suite
npm run typecheck           # strict, all three workspaces
npm run dev:server          # API with file watching
npm run dev:web             # Vite dev server
npm run migrate -- status   # applied and pending migrations
```

### Tests

Each test gets its own in-memory database, so suites are isolated and can run
concurrently. Put a new file in `packages/server/test/` named after what it
covers.

Write the negative cases. The valuable tests here are the ones that prove
something is *refused*: a dependency cycle, a stale write, a forged token, a
replayed challenge, a cloned passkey, a credential used against the wrong
account. A test that only proves the happy path has proved very little.

```bash
cd packages/server
NODE_ENV=test node --test --experimental-strip-types test/issue.test.ts
```

### Migrations

Add a new numbered SQL file. **Never edit an applied migration** — the runner
checksums them and refuses to start if one changed, because re-running a mutated
migration corrupts the schema. If you need a new column, add `004_…`.

### Dependencies

Add sparingly, and say in the pull request why an existing option was not enough.
Security-critical specifications are the exception where a vetted library is the
correct answer: this project uses `@simplewebauthn/server` for WebAuthn and
`xml-crypto` for SAML XML-DSIG rather than hand-rolling either, because
hand-rolled CBOR and hand-rolled C14N are how bypasses get shipped.

## Reporting a security issue

Please do **not** open a public issue. Email the maintainer with the details and
a reproduction. We will acknowledge it and work with you on a fix before it is
disclosed.

## Licence

By contributing you agree that your work is licensed under the
[MIT Licence](LICENSE), the same terms as the rest of the project.
