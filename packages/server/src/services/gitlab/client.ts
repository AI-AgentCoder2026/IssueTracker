/**
 * GitLab REST API v4 client.
 *
 * A thin, dependency-injected wrapper over the global `fetch`: no HTTP library
 * is added to the project. Everything the adapter needs is a thin method over
 * `request()`, which owns the three things that are easy to get wrong in a
 * token-bearing client:
 *
 *   * the access token is only ever sent in a header and is never included in
 *     an error message or a log line;
 *   * every request is bounded by `AbortSignal.timeout`, so a hung GitLab
 *     cannot pin a sync open forever;
 *   * pagination always terminates — loops are capped and rely on GitLab's
 *     `X-Next-Page`, which is empty on the last page.
 */

import { testConnectionSchema, type GitLabIssuePayload, type GitLabProjectPayload } from '@tracker/shared';
import { decrypt } from '../../lib/crypto.ts';
import { integrationError } from '../../errors.ts';
import type { Services } from '../context.ts';
import type { GitLabIssueWrite } from './mapper.ts';

// ---------------------------------------------------------------------------
// Wire shapes
// ---------------------------------------------------------------------------

export interface GitLabUser {
  id: number;
  username: string;
  name: string;
  email?: string;
  state?: string;
}

export interface GitLabNote {
  id: number;
  body: string;
  author: { id: number; name: string; username: string };
  created_at: string;
  updated_at: string;
  system: boolean;
}

export interface GitLabLabel {
  id: number;
  name: string;
  color: string;
  description: string | null;
}

export interface GitLabMember {
  id: number;
  username: string;
  name: string;
  access_level: number;
}

export interface GitLabGroup {
  id: number;
  name: string;
  full_path: string;
}

export interface GitLabHook {
  id: number;
  url: string;
  push_events: boolean;
  issues_events: boolean;
  note_events: boolean;
}

export interface ListIssuesOptions {
  state?: 'opened' | 'closed' | 'all';
  updatedAfter?: string | null;
  perPage?: number;
  page?: number;
}

export interface ClientOptions {
  baseUrl: string;
  accessToken: string;
  timeoutMs: number;
}

export interface RequestOptions {
  query?: Record<string, string | number | boolean | undefined | null>;
  body?: unknown;
  headers?: Record<string, string>;
}

/** Hard ceiling on paginated fetches, so a broken `X-Next-Page` cannot loop. */
const MAX_PAGES = 200;
const DEFAULT_PER_PAGE = 100;
/** How many times a rate-limited request is retried before giving up. */
const MAX_RATE_LIMIT_RETRIES = 3;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function joinUrl(baseUrl: string, path: string): string {
  const base = baseUrl.replace(/\/+$/, '');
  const suffix = path.startsWith('/') ? path : `/${path}`;
  return `${base}/api/v4${suffix}`;
}

/** Build a query string; `undefined`/`null` values are dropped, never stringified. */
export function buildQuery(
  query: Record<string, string | number | boolean | undefined | null> | undefined,
): string {
  if (!query) return '';
  const parts: string[] = [];
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '') continue;
    parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
  }
  return parts.length > 0 ? `?${parts.join('&')}` : '';
}

/**
 * Read a GitLab error body. GitLab answers errors as `{ message }` or
 * `{ error }`; only those fields are surfaced — never a request echo, which
 * could contain a token.
 */
export function extractGitLabMessage(body: unknown): string | null {
  if (typeof body === 'string' && body.trim() !== '') return body.slice(0, 500);
  if (body && typeof body === 'object') {
    const record = body as { message?: unknown; error?: unknown; error_description?: unknown };
    if (typeof record.message === 'string' && record.message) return record.message.slice(0, 500);
    if (typeof record.error === 'string' && record.error) return record.error.slice(0, 500);
    if (typeof record.error_description === 'string' && record.error_description) {
      return record.error_description.slice(0, 500);
    }
  }
  return null;
}

/** Parse a JSON body, tolerating the empty body of a 204. */
async function readBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text === '') return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export class GitLabClient {
  private readonly baseUrl: string;
  private readonly accessToken: string;
  private readonly timeoutMs: number;

  constructor(options: ClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.accessToken = options.accessToken;
    this.timeoutMs = options.timeoutMs > 0 ? options.timeoutMs : 20_000;
  }

  /** The instance this client talks to, with the API path stripped. */
  get instanceUrl(): string {
    return this.baseUrl;
  }

  /**
   * Perform one API call. Retries only on 429 (rate limit), honouring
   * `Retry-After` and backing off exponentially; every other non-2xx becomes
   * an `integrationError` whose message contains GitLab's own `message` field
   * but never the token.
   */
  async request<T>(
    method: string,
    path: string,
    options: RequestOptions = {},
  ): Promise<T> {
    const url = `${joinUrl(this.baseUrl, path)}${buildQuery(options.query)}`;

    for (let attempt = 0; attempt <= MAX_RATE_LIMIT_RETRIES; attempt += 1) {
      const headers: Record<string, string> = {
        'PRIVATE-TOKEN': this.accessToken,
        Accept: 'application/json',
        ...(options.headers ?? {}),
      };
      if (options.body !== undefined) headers['Content-Type'] = 'application/json';

      let response: Response;
      try {
        response = await fetch(url, {
          method,
          headers,
          body: options.body === undefined ? undefined : JSON.stringify(options.body),
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (error) {
        // Abort/timeout and DNS/TLS failures are integration faults, not bugs.
        const reason = error instanceof Error ? error.message : 'unknown transport error';
        throw integrationError(`GitLab request to ${path} failed: ${reason}`, {
          path,
          method,
        });
      }

      if (response.status === 429 && attempt < MAX_RATE_LIMIT_RETRIES) {
        await sleep(rateLimitDelay(response, attempt));
        continue;
      }

      if (response.status === 204 || response.status === 205) {
        return null as T;
      }

      const body = await readBody(response);

      if (response.ok) return body as T;

      if (response.status === 429) {
        throw integrationError(
          'GitLab rate limit exceeded; the request was not retried further',
          { path, method, status: 429 },
        );
      }
      if (response.status === 401) {
        throw integrationError('GitLab rejected the access token (401 unauthorized)', {
          path,
          method,
          status: 401,
        });
      }
      if (response.status === 403) {
        throw integrationError('GitLab denied access to this resource (403 forbidden)', {
          path,
          method,
          status: 403,
        });
      }
      if (response.status === 404) {
        throw integrationError(
          extractGitLabMessage(body) ?? `GitLab resource not found: ${path}`,
          { path, method, status: 404 },
        );
      }

      throw integrationError(
        extractGitLabMessage(body) ?? `GitLab request failed with status ${response.status}`,
        { path, method, status: response.status },
      );
    }

    /* c8 ignore next */
    throw integrationError('GitLab request exhausted its rate-limit retries', { path, method });
  }

  // -- user & project ------------------------------------------------------

  /** `GET /user` — the cheapest proof that a token is valid. */
  getCurrentUser(): Promise<GitLabUser> {
    return this.request<GitLabUser>('GET', '/user');
  }

  /** `GET /projects/:path` — `path` may be numeric or namespaced. */
  getProject(pathWithNamespace: string): Promise<GitLabProjectPayload> {
    return this.request<GitLabProjectPayload>(
      'GET',
      `/projects/${encodeURIComponent(pathWithNamespace)}`,
    );
  }

  // -- issues -------------------------------------------------------------

  /**
   * All issues of a project, following `X-Next-Page` until it is empty.
   * `updatedAfter` is an inclusive-lower-bound hint; the caller still has to
   * compare `updated_at` itself because GitLab rounds to the second.
   */
  async listIssues(projectId: number | string, options: ListIssuesOptions = {}): Promise<GitLabIssuePayload[]> {
    const perPage = Math.min(Math.max(options.perPage ?? DEFAULT_PER_PAGE, 1), 100);
    const collected: GitLabIssuePayload[] = [];

    for (let page = options.page ?? 1; page <= MAX_PAGES; page += 1) {
      const { items, nextPage } = await this.requestPage<GitLabIssuePayload>('GET', `/projects/${projectId}/issues`, {
        query: {
          state: options.state ?? 'all',
          updated_after: options.updatedAfter ?? undefined,
          per_page: perPage,
          page,
          order_by: 'updated_at',
          sort: 'asc',
        },
      });
      collected.push(...items);
      if (nextPage === null) break;
    }

    return collected;
  }

  getIssue(projectId: number | string, iid: number): Promise<GitLabIssuePayload> {
    return this.request<GitLabIssuePayload>('GET', `/projects/${projectId}/issues/${iid}`);
  }

  createIssue(
    projectId: number | string,
    payload: GitLabIssueWrite & { iid?: number },
  ): Promise<GitLabIssuePayload> {
    return this.request<GitLabIssuePayload>('POST', `/projects/${projectId}/issues`, { body: payload });
  }

  updateIssue(
    projectId: number | string,
    iid: number,
    payload: Partial<GitLabIssueWrite>,
  ): Promise<GitLabIssuePayload> {
    return this.request<GitLabIssuePayload>('PUT', `/projects/${projectId}/issues/${iid}`, {
      body: payload,
    });
  }

  deleteIssue(projectId: number | string, iid: number): Promise<void> {
    return this.request<void>('DELETE', `/projects/${projectId}/issues/${iid}`);
  }

  // -- notes --------------------------------------------------------------

  async listNotes(
    projectId: number | string,
    iid: number,
    options: { perPage?: number } = {},
  ): Promise<GitLabNote[]> {
    const perPage = Math.min(Math.max(options.perPage ?? DEFAULT_PER_PAGE, 1), 100);
    const collected: GitLabNote[] = [];

    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const { items, nextPage } = await this.requestPage<GitLabNote>(
        'GET',
        `/projects/${projectId}/issues/${iid}/notes`,
        { query: { per_page: perPage, page, sort: 'asc', order_by: 'created_at' } },
      );
      collected.push(...items);
      if (nextPage === null) break;
    }

    return collected;
  }

  createNote(projectId: number | string, iid: number, body: string): Promise<GitLabNote> {
    return this.request<GitLabNote>('POST', `/projects/${projectId}/issues/${iid}/notes`, {
      body: { body },
    });
  }

  // -- project metadata ----------------------------------------------------

  async listLabels(projectId: number | string): Promise<GitLabLabel[]> {
    const collected: GitLabLabel[] = [];
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const { items, nextPage } = await this.requestPage<GitLabLabel>(
        'GET',
        `/projects/${projectId}/labels`,
        { query: { per_page: 100, page } },
      );
      collected.push(...items);
      if (nextPage === null) break;
    }
    return collected;
  }

  async listMemberships(projectId: number | string): Promise<GitLabMember[]> {
    const collected: GitLabMember[] = [];
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const { items, nextPage } = await this.requestPage<GitLabMember>(
        'GET',
        `/projects/${projectId}/members`,
        { query: { per_page: 100, page } },
      );
      collected.push(...items);
      if (nextPage === null) break;
    }
    return collected;
  }

  async listGroups(): Promise<GitLabGroup[]> {
    const collected: GitLabGroup[] = [];
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const { items, nextPage } = await this.requestPage<GitLabGroup>('GET', '/groups', {
        query: { per_page: 100, page },
      });
      collected.push(...items);
      if (nextPage === null) break;
    }
    return collected;
  }

  /** `GET /projects/:id/hooks` — used to tell a user what to configure. */
  listProjectHooks(projectId: number | string): Promise<GitLabHook[]> {
    return this.request<GitLabHook[]>('GET', `/projects/${projectId}/hooks`);
  }

  // -- internals -----------------------------------------------------------

  /**
   * One paginated request, returning the items and the next page number (or
   * null when GitLab reported no further page). Reading `X-Next-Page` rather
   * than comparing lengths is what makes the loop terminate correctly.
   */
  private async requestPage<T>(
    method: string,
    path: string,
    options: RequestOptions = {},
  ): Promise<{ items: T[]; nextPage: number | null }> {
    const url = `${joinUrl(this.baseUrl, path)}${buildQuery(options.query)}`;
    const response = await fetch(url, {
      method,
      headers: {
        'PRIVATE-TOKEN': this.accessToken,
        Accept: 'application/json',
        ...(options.headers ?? {}),
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    if (response.status === 429) {
      const body = await readBody(response);
      throw integrationError(
        extractGitLabMessage(body) ?? 'GitLab rate limit exceeded while paginating',
        { path, method, status: 429 },
      );
    }
    if (!response.ok) {
      const body = await readBody(response);
      const message =
        response.status === 401
          ? 'GitLab rejected the access token (401 unauthorized)'
          : response.status === 403
            ? 'GitLab denied access to this resource (403 forbidden)'
            : (extractGitLabMessage(body) ?? `GitLab request failed with status ${response.status}`);
      throw integrationError(message, { path, method, status: response.status });
    }

    const parsed = await readBody(response);
    const items = Array.isArray(parsed) ? (parsed as T[]) : [];
    const nextHeader = response.headers.get('x-next-page');
    const nextPage = nextHeader && nextHeader.trim() !== '' ? Number(nextHeader) : null;

    return {
      items,
      nextPage: nextPage !== null && Number.isFinite(nextPage) && nextPage > 0 ? nextPage : null,
    };
  }
}

/** Backoff for a 429: honour `Retry-After`, otherwise grow exponentially. */
function rateLimitDelay(response: Response, attempt: number): number {
  const retryAfter = Number(response.headers.get('retry-after'));
  if (Number.isFinite(retryAfter) && retryAfter > 0) {
    return Math.min(retryAfter * 1000, 60_000);
  }
  return Math.min(1000 * 2 ** attempt, 30_000);
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/** Minimal stored-connection shape the factory needs to build a client. */
export interface StoredConnectionCredentials {
  base_url: string;
  access_token_encrypted: string;
}

export interface TestConnectionInput {
  baseUrl: string;
  accessToken: string;
  gitlabProjectPath?: string;
}

export interface TestConnectionResult {
  user: { id: number; username: string; name: string };
  project?: {
    id: number;
    pathWithNamespace: string;
    name: string;
    webUrl: string;
    issuesEnabled: boolean;
  };
  baseUrl: string;
}

/**
 * Builds `GitLabClient` instances, decrypting stored tokens with the instance
 * key. A decryption failure is an `integration_error` that says so without
 * echoing anything about the ciphertext.
 */
export class GitLabClientFactory {
  private readonly services: Services;

  constructor(services: Services) {
    this.services = services;
  }

  /** Build a client from an explicit token (connection form / test route). */
  forInput(input: { baseUrl: string; accessToken: string }): GitLabClient {
    return new GitLabClient({
      baseUrl: input.baseUrl,
      accessToken: input.accessToken,
      timeoutMs: this.services.config.gitlabTimeoutMs,
    });
  }

  /** Build a client for a stored connection row by decrypting its token. */
  forRow(row: StoredConnectionCredentials): GitLabClient {
    let accessToken: string;
    try {
      accessToken = decrypt(row.access_token_encrypted, this.services.config.encryptionKey);
    } catch {
      throw integrationError(
        'The stored GitLab access token could not be decrypted; re-enter it on the connection settings',
      );
    }
    return this.forInput({ baseUrl: row.base_url, accessToken });
  }

  /** Build a client for a connection object carrying the encrypted token. */
  forConnection(connection: {
    baseUrl: string;
    accessTokenEncrypted: string;
  }): GitLabClient {
    return this.forRow({
      base_url: connection.baseUrl,
      access_token_encrypted: connection.accessTokenEncrypted,
    });
  }

  /** Verify a token (and optionally a project) without persisting anything. */
  testConnection(input: TestConnectionInput): Promise<TestConnectionResult> {
    return testConnection(this.services, input);
  }
}

/** Validate and execute a connection test. Used by the `/api/gitlab/test` route. */
export async function testConnection(
  services: Services,
  input: TestConnectionInput,
): Promise<TestConnectionResult> {
  const parsed = testConnectionSchema.parse({
    baseUrl: input.baseUrl,
    accessToken: input.accessToken,
    gitlabProjectPath: input.gitlabProjectPath,
  });

  const client = new GitLabClientFactory(services).forInput({
    baseUrl: parsed.baseUrl,
    accessToken: parsed.accessToken,
  });

  const user = await client.getCurrentUser();
  const result: TestConnectionResult = {
    user: { id: user.id, username: user.username, name: user.name },
    baseUrl: client.instanceUrl,
  };

  if (parsed.gitlabProjectPath) {
    const project = await client.getProject(parsed.gitlabProjectPath);
    result.project = {
      id: project.id,
      pathWithNamespace: project.path_with_namespace,
      name: project.name,
      webUrl: project.web_url,
      issuesEnabled: project.issues_enabled,
    };
  }

  return result;
}
