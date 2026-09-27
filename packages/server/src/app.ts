/**
 * Fastify application assembly.
 *
 * Registration order matters in two places:
 *
 *  1. `authPlugin` must come first so every later route has `request.context`.
 *  2. `searchRoutes` and `bulkRoutes` are registered before `issueRoutes`,
 *     because Fastify matches routes in registration order and the literal
 *     `/api/issues/search` path would otherwise be captured by `/api/issues/:issueId`.
 */

import { existsSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { sep } from 'node:path';
import { resolve } from 'node:path';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import websocket from '@fastify/websocket';
import Fastify, { type FastifyInstance } from 'fastify';
import { ZodError } from 'zod';

import { loadConfig, webClientIndex, type Config } from './config.ts';
import { AppError, isAppError } from './errors.ts';
import { Database } from './db/connection.ts';
import { migrate } from './db/migrate.ts';
import { createServices } from './services/registry.ts';
import type { Services } from './services/context.ts';
import { registerRealtimeGateway } from './realtime/gateway.ts';
import { Scheduler } from './jobs/scheduler.ts';
import { authPlugin } from './plugins/auth.plugin.ts';

import { authRoutes } from './routes/auth.routes.ts';
import { userRoutes } from './routes/users.routes.ts';
import { boardRoutes, projectRoutes } from './routes/projects.routes.ts';
import {
  adminRoutes,
  attachmentRoutes,
  commentRoutes,
  notificationRoutes,
} from './routes/collaboration.routes.ts';

// Registered before `issueRoutes` so the literal paths win the match.
import { searchRoutes, bulkRoutes } from './routes/search.routes.ts';
import { issueRoutes } from './routes/issues.routes.ts';

import { gitlabRoutes, gitlabWebhookRoutes, webhookRoutes } from './routes/gitlab.routes.ts';
import { dashboardRoutes } from './routes/dashboards.routes.ts';
import { slaRoutes } from './routes/sla.routes.ts';

export interface BuildAppOptions {
  config?: Partial<Config>;
  /** Reuse an existing database, e.g. in tests. */
  db?: Database;
  /** Skip migration, for tests that manage the schema themselves. */
  migrate?: boolean;
  /** Skip the background scheduler, which tests trigger explicitly. */
  enableScheduler?: boolean;
}

export interface TrackerApp {
  app: FastifyInstance;
  config: Config;
  db: Database;
  services: Services;
  scheduler: Scheduler;
  close(): Promise<void>;
}

export async function buildApp(options: BuildAppOptions = {}): Promise<TrackerApp> {
  const config = loadConfig(options.config);

  const db =
    options.db ??
    new Database({ file: config.databaseFile, wal: config.env !== 'test' });

  // Migration logging goes to stdout until the Fastify logger exists; the
  // messages are replayed into the app log once it is built.
  const migrationLog: string[] = [];
  if (options.migrate !== false) {
    migrate(db, { log: (message) => migrationLog.push(message) });
  }

  const services = createServices({ config, db });

  const app = Fastify({
    logger: {
      level: config.logLevel,
      // Redact anything that could carry a credential into the log stream.
      redact: {
        paths: [
          'req.headers.authorization',
          'req.headers.cookie',
          'res.headers["set-cookie"]',
          '*.password',
          '*.accessToken',
          '*.token',
          '*.clientSecret',
        ],
        censor: '[REDACTED]',
      },
      transport: undefined,
    },
    trustProxy: config.trustProxy,
    bodyLimit: config.maxUploadBytes,
    ajv: { customOptions: { removeAdditional: 'all', coerceTypes: true, useDefaults: true } },
  });

  // -- core plugins --------------------------------------------------------
  await app.register(cookie, { secret: config.sessionSecret });
  await app.register(cors, {
    origin: config.corsOrigins.length > 0 ? config.corsOrigins : true,
    credentials: true,
  });
  await app.register(websocket, { options: { maxPayload: 1024 * 1024 } });
  await app.register(rateLimit, {
    max: 300,
    timeWindow: '1 minute',
    // Login is rate-limited separately and much more aggressively.
    hook: 'onRequest',
  });
  await app.register(multipart, {
    limits: { fileSize: config.maxUploadBytes, files: 10, fields: 20 },
  });

  app.decorate('config', config);
  app.decorate('db', db);
  app.decorate('services', services);

  // Resolves the principal and attaches `request.context`.
  await app.register(authPlugin);

  // -- error handling ------------------------------------------------------
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ZodError) {
      const fields = error.issues.map((issue) => ({
        path: issue.path.map(String).join('.') || '_root',
        message: issue.message,
      }));
      void reply.status(422).send({
        error: { code: 'validation_failed', message: 'The request failed validation', fields },
      });
      return;
    }

    if (isAppError(error)) {
      if (error.status >= 500) request.log.error({ err: error }, 'request failed');
      void reply.status(error.status).send(error.toBody(request.id));
      return;
    }

    // Fastify's own errors (payload too large, malformed JSON, 404) carry a
    // statusCode; map the common ones onto the shared error codes.
    const statusCode = (error as { statusCode?: number }).statusCode ?? 500;
    if (statusCode === 413) {
      void reply.status(413).send({
        error: { code: 'payload_too_large', message: 'The request body is too large' },
      });
      return;
    }
    if (statusCode === 415) {
      void reply.status(415).send({
        error: { code: 'unsupported_media', message: 'Unsupported media type' },
      });
      return;
    }
    if (statusCode === 429) {
      void reply.status(429).send({
        error: { code: 'rate_limited', message: 'Too many requests' },
      });
      return;
    }
    if (statusCode === 400) {
      const message = error instanceof Error ? error.message : 'Malformed request';
      void reply.status(400).send({
        error: { code: 'bad_request', message },
      });
      return;
    }
    if (statusCode === 404) {
      void reply.status(404).send({
        error: { code: 'not_found', message: 'Route not found' },
      });
      return;
    }

    // Anything unexpected: log with the stack, return an opaque message.
    request.log.error({ err: error }, 'unhandled error');
    void reply.status(500).send({
      error: { code: 'internal_error', message: 'An unexpected error occurred', requestId: request.id },
    });
  });

  // The 404 handler is installed once, at the end of `buildApp`, because the
  // SPA fallback depends on whether a built client was found. Registering it
  // here too would be silently overwritten.

  // -- routes --------------------------------------------------------------
  // Inbound GitLab webhooks are unauthenticated (they carry a per-connection
  // secret) and must be registered before the auth plugin rejects anonymous
  // access to /api routes. They live outside /api, so ordering is safe either
  // way, but keeping them early documents the intent.
  await app.register(gitlabWebhookRoutes);

  await app.register(authRoutes);
  await app.register(userRoutes);
  await app.register(notificationRoutes);

  // Literal-path routes before parameterised ones.
  await app.register(searchRoutes);
  await app.register(bulkRoutes);

  await app.register(projectRoutes);
  await app.register(issueRoutes);
  await app.register(boardRoutes);
  await app.register(commentRoutes);
  await app.register(attachmentRoutes);

  await app.register(dashboardRoutes);
  await app.register(slaRoutes);
  await app.register(gitlabRoutes);
  await app.register(webhookRoutes);
  await app.register(adminRoutes);

  // -- realtime ------------------------------------------------------------
  registerRealtimeGateway(app, services.realtime);

  // -- static SPA ----------------------------------------------------------
  const indexPath = webClientIndex(config);
  const hasWebClient = config.serveWebClient && indexPath !== null;
  const webDir = hasWebClient ? resolve(config.webClientDir) : null;
  let spaShell: string | null = null;

  if (hasWebClient && webDir && indexPath) {
    // Read the shell once at boot. `reply.sendFile` is not used: it resolves
    // against the application root (the process working directory) rather than
    // the static plugin's root, which yields a 403 for a file that exists.
    spaShell = readFileSync(indexPath, 'utf8');

    /**
     * Serve one built asset.
     *
     * A small explicit handler beats a wildcard static mount here: the path is
     * validated against the assets directory before any read, so a crafted
     * `../../` request cannot escape, and a wildcard at `/` would intercept
     * `GET /` and fail before the SPA fallback below ever ran.
     */
    app.get('/assets/*', async (request, reply) => {
      const relative = (request.params as { '*': string })['*'] ?? '';
      const assetsRoot = resolve(webDir, 'assets');
      const target = resolve(assetsRoot, relative);

      // Reject anything that does not resolve to a regular file inside the
      // assets directory.
      if (target !== assetsRoot && !target.startsWith(assetsRoot + sep)) {
        void reply.status(404).send({ error: { code: 'not_found', message: 'Not found' } });
        return;
      }
      if (!existsSync(target)) {
        void reply.status(404).send({ error: { code: 'not_found', message: 'Not found' } });
        return;
      }

      const body = await readFile(target);      return reply
        .header('Content-Type', contentTypeFor(target))
        // Hashed filenames are safe to cache aggressively; the shell is not.
        .header('Cache-Control', 'public, max-age=31536000, immutable')
        .send(body);
    });
  }

  // Single 404 handler: with a built client present, a non-API GET returns the
  // SPA shell so client-side deep links survive a hard refresh; everything else
  // gets the JSON error envelope.
  app.setNotFoundHandler((request, reply) => {
    if (spaShell !== null && request.method === 'GET' && !request.url.startsWith('/api')) {
      void reply.header('Content-Type', 'text/html; charset=utf-8').send(spaShell);
      return;
    }
    void reply.status(404).send({
      error: { code: 'not_found', message: `Route ${request.method} ${request.url} not found` },
    });
  });

  // -- bootstrap & scheduler ----------------------------------------------
  try {
    await services.auth.ensureBootstrapAdmin();
  } catch (error) {
    app.log.error({ err: error }, 'failed to bootstrap the admin account');
  }

  const scheduler = new Scheduler(services, {
    runOnStart: options.enableScheduler === true,
  });
  scheduler.start();

  for (const message of migrationLog) app.log.info(message);

  app.addHook('onClose', async () => {
    scheduler.stop();
  });

  return {
    app,
    config,
    db,
    services,
    scheduler,
    async close() {
      await app.close();
      if (!options.db) db.close();
    },
  };
}


/**
 * Content type for a built asset. Only the handful of types a Vite build emits
 * are listed; anything unknown falls back to a neutral binary type and is sent
 * as an attachment-safe `Content-Type` rather than being guessed.
 */
function contentTypeFor(path: string): string {
  const extension = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
  const types: Record<string, string> = {
    js: 'text/javascript; charset=utf-8',
    mjs: 'text/javascript; charset=utf-8',
    css: 'text/css; charset=utf-8',
    html: 'text/html; charset=utf-8',
    json: 'application/json; charset=utf-8',
    svg: 'image/svg+xml',
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    ico: 'image/x-icon',
    woff: 'font/woff',
    woff2: 'font/woff2',
    ttf: 'font/ttf',
    map: 'application/json; charset=utf-8',
    txt: 'text/plain; charset=utf-8',
    webmanifest: 'application/manifest+json',
  };
  return types[extension] ?? 'application/octet-stream';
}
export { AppError };
export default buildApp;
