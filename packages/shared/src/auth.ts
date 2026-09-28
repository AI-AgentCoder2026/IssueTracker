/**
 * Authentication contracts: local credentials, API tokens and time-bound guest
 * access.
 */

import { z } from 'zod';
import type { IsoDateTime, ProjectId, UserId } from './ids.ts';
import type { Role } from './rbac.ts';

export const AUTH_PROVIDERS = ['local', 'ldap', 'guest'] as const;
export type AuthProvider = (typeof AUTH_PROVIDERS)[number];

export interface User {
  id: UserId;
  username: string;
  email: string;
  displayName: string;
  avatarUrl: string | null;
  /** Null for an account that has never set a password. */
  passwordHash: string | null;
  provider: AuthProvider;
  /** Instance administrator bypasses per-project membership checks. */
  isInstanceAdmin: boolean;
  isActive: boolean;
  /** IANA timezone, used for SLA and due-date presentation. */
  timezone: string;
  locale: string;
  lastLoginAt: IsoDateTime | null;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

/** Instance-level role, separate from per-project membership. */
export const INSTANCE_ROLES = ['user', 'staff', 'admin'] as const;
export type InstanceRole = (typeof INSTANCE_ROLES)[number];

export interface Membership {
  id: number;
  projectId: ProjectId;
  userId: UserId;
  role: Role;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

/** Long-lived token for CI, bots and scripts. Shown once, stored hashed. */
export interface ApiToken {
  id: number;
  userId: UserId;
  name: string;
  /** First 8 characters, so a user can identify the token later. */
  prefix: string;
  scopes: string[];
  projectIds: ProjectId[];
  expiresAt: IsoDateTime | null;
  lastUsedAt: IsoDateTime | null;
  revokedAt: IsoDateTime | null;
  createdAt: IsoDateTime;
}

/**
 * Time-bound guest access. A guest can be limited to a single project, a set of
 * roles for permission purposes, and read-only or comment-only.
 */
export interface GuestToken {
  id: number;
  projectId: ProjectId;
  /** Optional: restrict to one issue, for review links. */
  issueId: number | null;
  label: string;
  tokenHash: string;
  /** Role the guest is treated as inside the project. */
  role: Role;
  /** Guests may comment but not edit fields. */
  canComment: boolean;
  expiresAt: IsoDateTime;
  maxUses: number | null;
  useCount: number;
  revokedAt: IsoDateTime | null;
  createdBy: UserId;
  createdAt: IsoDateTime;
}

export interface Session {
  id: string;
  userId: UserId;
  ipAddress: string;
  userAgent: string;
  expiresAt: IsoDateTime;
  createdAt: IsoDateTime;
  lastSeenAt: IsoDateTime;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export const registerSchema = z.object({
  username: z
    .string()
    .trim()
    .min(3)
    .max(64)
    .regex(/^[a-zA-Z0-9._-]+$/, 'may contain letters, numbers, dot, underscore and hyphen'),
  email: z.string().trim().email().max(320),
  displayName: z.string().trim().min(1).max(120),
  password: z
    .string()
    .min(12, 'password must be at least 12 characters')
    .max(200)
    .refine((p) => /[a-z]/.test(p) && /[A-Z]/.test(p) && /\d/.test(p), {
      message: 'password must include lower case, upper case and a digit',
    }),
});

export const loginSchema = z.object({
  login: z.string().trim().min(1).max(320),
  password: z.string().min(1).max(200),
});

export const updateProfileSchema = z.object({
  displayName: z.string().trim().min(1).max(120).optional(),
  avatarUrl: z.string().url().max(2000).nullable().optional(),
  timezone: z.string().trim().min(1).max(64).optional(),
  locale: z.string().trim().min(2).max(16).optional(),
});

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(200),
  newPassword: registerSchema.shape.password,
});

export const createApiTokenSchema = z.object({
  name: z.string().trim().min(1).max(80),
  scopes: z.array(z.string().trim().min(1).max(64)).max(20).default([]),
  projectIds: z.array(z.number().int().positive()).max(100).default([]),
  /** ISO timestamp; null means non-expiring. */
  expiresAt: z.string().datetime().nullable().default(null),
});

export const createGuestTokenSchema = z.object({
  projectId: z.number().int().positive(),
  issueId: z.number().int().positive().nullable().default(null),
  label: z.string().trim().min(1).max(120),
  role: z.enum(['viewer', 'reporter'] as const).default('viewer'),
  canComment: z.boolean().default(false),
  expiresAt: z.string().datetime(),
  maxUses: z.number().int().min(1).max(1000).nullable().default(null),
});

export type CreateGuestTokenInput = z.infer<typeof createGuestTokenSchema>;

/** Response shape for a successful login or token exchange. */
export interface AuthResult {
  user: Omit<User, 'passwordHash'>;
  /** Opaque session id, sent as an httpOnly cookie. */
  sessionId: string;
  expiresAt: IsoDateTime;
}

/** Password hashing parameters, exposed for the settings UI. */
export interface PasswordPolicy {
  minLength: number;
  requireUpper: boolean;
  requireLower: boolean;
  requireDigit: boolean;
  maxLength: number;
}

export const DEFAULT_PASSWORD_POLICY: PasswordPolicy = {
  minLength: 12,
  requireUpper: true,
  requireLower: true,
  requireDigit: true,
  maxLength: 200,
};
