/**
 * Fetch wrapper around the pinned HTTP contract.
 *
 * Responsibilities:
 *  - attach the session (cookie + bearer fallback) to every request,
 *  - unwrap the server's `{ error: { code, message, fields } }` envelope into a
 *    typed `ApiError`,
 *  - clear the stored session and broadcast on 401 so the auth layer can
 *    redirect to `/login`.
 *
 * Every path comes from `API` in `@tracker/shared`; no URL string is written by
 * hand anywhere else in the client.
 */

import {
  API,
  fill,
  type ApiErrorBody,
  type ErrorCode,
  type FieldError,
} from '@tracker/shared';

const SESSION_KEY = 'tracker.sessionId';

/** Thrown for any non-2xx response. Carries the server's machine-readable code. */
export class ApiError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly fields: readonly FieldError[];
  readonly details: Record<string, unknown> | null;
  readonly requestId: string | null;

  constructor(init: {
    code: ErrorCode;
    message: string;
    status: number;
    fields?: readonly FieldError[];
    details?: Record<string, unknown> | null;
    requestId?: string | null;
  }) {
    super(init.message);
    this.name = 'ApiError';
    this.code = init.code;
    this.status = init.status;
    this.fields = init.fields ?? [];
    this.details = init.details ?? null;
    this.requestId = init.requestId ?? null;
  }

  /** Field-level message for a form input, if the server reported one. */
  fieldMessage(path: string): string | null {
    const hit = this.fields.find((f) => f.path === path || f.path.endsWith(`.${path}`));
    return hit ? hit.message : null;
  }

  /** True for failures the user can realistically fix by editing the form. */
  get isValidation(): boolean {
    return this.code === 'validation_failed' || this.fields.length > 0;
  }
}

/** Network/parse failures that never reached the server's error handler. */
export function toApiError(cause: unknown): ApiError {
  if (cause instanceof ApiError) return cause;
  const message = cause instanceof Error ? cause.message : 'Network request failed';
  return new ApiError({ code: 'internal_error', message, status: 0 });
}

// ---------------------------------------------------------------------------
// Session storage
// ---------------------------------------------------------------------------

let sessionId: string | null = null;

export function getSessionId(): string | null {
  return sessionId;
}

export function setSessionId(value: string | null): void {
  sessionId = value;
  try {
    if (value === null) window.localStorage.removeItem(SESSION_KEY);
    else window.localStorage.setItem(SESSION_KEY, value);
  } catch {
    // Private-mode browsers reject storage writes; the cookie still authenticates.
  }
}

/** Reads the persisted session id at boot, before the first render. */
export function restoreSessionId(): string | null {
  try {
    sessionId = window.localStorage.getItem(SESSION_KEY);
  } catch {
    sessionId = null;
  }
  return sessionId;
}

type UnauthorizedListener = () => void;
const unauthorizedListeners = new Set<UnauthorizedListener>();

/** Subscribe to "the stored session stopped working" notifications. */
export function onUnauthorized(listener: UnauthorizedListener): () => void {
  unauthorizedListeners.add(listener);
  return () => unauthorizedListeners.delete(listener);
}

function broadcastUnauthorized(): void {
  setSessionId(null);
  for (const listener of unauthorizedListeners) listener();
}

// ---------------------------------------------------------------------------
// Query strings
// ---------------------------------------------------------------------------

export type QueryValue = string | number | boolean | null | undefined;
export type QueryParams = Record<string, QueryValue | readonly QueryValue[]>;

/**
 * Serialises arrays as repeated keys (`states=open&states=closed`), which is what
 * the API's query parsing expects. `null` and `undefined` are omitted so an
 * unset filter is indistinguishable from a missing parameter.
 */
export function toQueryString(params: QueryParams): string {
  const search = new URLSearchParams();
  for (const [key, raw] of Object.entries(params)) {
    const values = Array.isArray(raw) ? raw : [raw as QueryValue];
    for (const value of values) {
      if (value === null || value === undefined) continue;
      search.append(key, String(value));
    }
  }
  const text = search.toString();
  return text ? `?${text}` : '';
}

// ---------------------------------------------------------------------------
// Core request
// ---------------------------------------------------------------------------

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /** JSON-serialised automatically unless `form` is supplied. */
  body?: unknown;
  /** Multipart payload; sent as-is with a browser-managed boundary. */
  form?: FormData;
  query?: QueryParams;
  signal?: AbortSignal;
}

function headersFor(hasBody: boolean): Headers {
  const headers = new Headers();
  headers.set('Accept', 'application/json');
  if (hasBody) headers.set('Content-Type', 'application/json');
  // The server sets an httpOnly session cookie; the bearer header is the
  // fallback used when the cookie is unavailable (e.g. cross-site deploy).
  const token = sessionId;
  if (token !== null) headers.set('Authorization', `Bearer ${token}`);
  return headers;
}

function isErrorBody(value: unknown): value is ApiErrorBody {
  if (typeof value !== 'object' || value === null || !('error' in value)) return false;
  const err = (value as { error: unknown }).error;
  return typeof err === 'object' && err !== null && 'code' in err && 'message' in err;
}

async function readError(response: Response): Promise<ApiError> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return new ApiError({
      code: 'internal_error',
      message: `Request failed with status ${response.status}`,
      status: response.status,
    });
  }
  if (isErrorBody(body)) {
    const { code, message, fields, details, requestId } = body.error;
    return new ApiError({
      code: (code ?? 'internal_error') as ErrorCode,
      message: message || 'Request failed',
      status: response.status,
      fields: Array.isArray(fields) ? fields : [],
      details: details ?? null,
      requestId: requestId ?? response.headers.get('x-request-id'),
    });
  }
  return new ApiError({
    code: 'internal_error',
    message: `Request failed with status ${response.status}`,
    status: response.status,
  });
}

/** Performs one request against a filled `API` path and returns parsed JSON. */
export async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const url = `${path}${options.query ? toQueryString(options.query) : ''}`;
  const init: RequestInit = {
    method: options.method ?? 'GET',
    credentials: 'include',
    headers: headersFor(options.body !== undefined || options.form !== undefined),
    signal: options.signal,
  };
  if (options.form !== undefined) {
    init.body = options.form;
    // Content-Type is intentionally omitted so the browser sets the boundary.
    init.headers = new Headers({ Accept: 'application/json' });
    const token = sessionId;
    if (token !== null) (init.headers as Headers).set('Authorization', `Bearer ${token}`);
  } else if (options.body !== undefined) {
    init.body = JSON.stringify(options.body);
  }

  let response: Response;
  try {
    response = await fetch(url, init);
  } catch (cause) {
    if (cause instanceof DOMException && cause.name === 'AbortError') throw cause;
    throw toApiError(cause);
  }

  if (response.status === 401) {
    broadcastUnauthorized();
    throw await readError(response);
  }
  if (!response.ok) throw await readError(response);

  if (response.status === 204) return undefined as T;
  const text = await response.text();
  if (text === '') return undefined as T;
  try {
    return JSON.parse(text) as T;
  } catch (cause) {
    throw toApiError(cause);
  }
}

/**
 * Performs one request and returns the response as a file.
 *
 * Export is the only endpoint that answers with an attachment rather than JSON,
 * and it is `POST` because the request body carries a filter. Parsing it through
 * `request` would try to `JSON.parse` a CSV and fail, so the download path is
 * separate and reads `Content-Disposition` for the filename the server chose.
 */
export async function download(path: string, body: unknown): Promise<{ filename: string; blob: Blob }> {
  const response = await fetch(path, {
    method: 'POST',
    credentials: 'include',
    headers: headersFor(true),
    body: JSON.stringify(body),
  });

  if (response.status === 401) {
    broadcastUnauthorized();
    throw await readError(response);
  }
  if (!response.ok) throw await readError(response);

  const disposition = response.headers.get('content-disposition') ?? '';
  // The server pins the filename; the quoted form is the one it sends.
  const match = /filename="([^"]+)"/.exec(disposition);
  return {
    filename: match?.[1] ?? 'export',
    blob: await response.blob(),
  };
}

/** Hands a downloaded blob to the browser as a file the user keeps. */
export function saveFile(filename: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  // Revoking immediately can cancel the download in some browsers.
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

export const http = {
  get: <T>(path: string, options?: Omit<RequestOptions, 'method' | 'body' | 'form'>) =>
    request<T>(path, { ...options, method: 'GET' }),
  post: <T>(path: string, body?: unknown, options?: Omit<RequestOptions, 'method' | 'body'>) =>
    request<T>(path, { ...options, method: 'POST', body }),
  put: <T>(path: string, body?: unknown, options?: Omit<RequestOptions, 'method' | 'body'>) =>
    request<T>(path, { ...options, method: 'PUT', body }),
  patch: <T>(path: string, body?: unknown, options?: Omit<RequestOptions, 'method' | 'body'>) =>
    request<T>(path, { ...options, method: 'PATCH', body }),
  delete: <T>(path: string, options?: Omit<RequestOptions, 'method' | 'body'>) =>
    request<T>(path, { ...options, method: 'DELETE' }),
};

export { API, fill };
