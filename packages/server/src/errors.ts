/**
 * Error model.
 *
 * Every failure the API returns is an `AppError`, so a handler can throw and the
 * central error serializer decides the shape. Unexpected exceptions are logged
 * with their stack and reported as a generic `internal_error` — internal
 * messages and SQL never reach a client.
 */

import { ERROR_STATUS, type ApiErrorBody, type ErrorCode, type FieldError } from '@tracker/shared';

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details: Record<string, unknown> | undefined;
  readonly fields: FieldError[] | undefined;
  /** Marks errors that are safe to show to the user verbatim. */
  readonly expose: boolean;

  constructor(
    code: ErrorCode,
    message: string,
    options: {
      status?: number;
      details?: Record<string, unknown>;
      fields?: FieldError[];
      cause?: unknown;
      expose?: boolean;
    } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'AppError';
    this.code = code;
    this.status = options.status ?? ERROR_STATUS[code];
    this.details = options.details;
    this.fields = options.fields;
    this.expose = options.expose ?? this.status < 500;
  }

  toBody(requestId?: string): ApiErrorBody {
    const error: ApiErrorBody['error'] = {
      code: this.code,
      message: this.expose ? this.message : 'An unexpected error occurred',
    };
    if (this.details && Object.keys(this.details).length > 0) error.details = this.details;
    if (this.fields && this.fields.length > 0) error.fields = this.fields;
    if (requestId) error.requestId = requestId;
    return { error };
  }
}

export const badRequest = (message: string, details?: Record<string, unknown>) =>
  new AppError('bad_request', message, { details });

export const unauthenticated = (message = 'Authentication required') =>
  new AppError('unauthenticated', message);

export const forbidden = (message = 'You do not have permission to perform this action') =>
  new AppError('forbidden', message);

export const notFound = (entity: string, id?: string | number) =>
  new AppError('not_found', id === undefined ? `${entity} not found` : `${entity} "${id}" not found`, {
    details: id === undefined ? undefined : { entity, id },
  });

export const conflict = (message: string, details?: Record<string, unknown>) =>
  new AppError('conflict', message, { details });

export const payloadTooLarge = (message = 'Payload is too large') =>
  new AppError('payload_too_large', message);

export const unsupportedMedia = (message = 'Unsupported media type') =>
  new AppError('unsupported_media', message);

export const rateLimited = (message = 'Too many requests') =>
  new AppError('rate_limited', message);

export const immutableViolation = (message: string) =>
  new AppError('immutable_violation', message);

export const syncConflict = (message: string, details?: Record<string, unknown>) =>
  new AppError('sync_conflict', message, { details });

export const versionConflict = (current: number, expected: number) =>
  new AppError(
    'version_conflict',
    'This issue was modified by someone else. Reload to see the latest version.',
    { details: { currentVersion: current, expectedVersion: expected } },
  );

export const workflowViolation = (message: string, details?: Record<string, unknown>) =>
  new AppError('workflow_violation', message, { details });

export const cycleDetected = (message = 'This change would create a circular dependency') =>
  new AppError('cycle_detected', message);

export const integrationError = (message: string, details?: Record<string, unknown>) =>
  new AppError('integration_error', message, { details });

export const internalError = (message = 'Internal server error', cause?: unknown) =>
  new AppError('internal_error', message, { cause, expose: false });

/** Convert a Zod error into the field-error shape clients expect. */
export function fromZodError(error: unknown): AppError {
  const issues = (error as { issues?: Array<{ path: unknown[]; message: string }> })?.issues ?? [];
  const fields: FieldError[] = issues.map((issue) => ({
    path: issue.path.map(String).join('.') || '_root',
    message: issue.message,
  }));
  return new AppError('validation_failed', 'The request body failed validation', {
    fields,
    details: { issueCount: fields.length },
  });
}

export function isAppError(value: unknown): value is AppError {
  return value instanceof AppError;
}
