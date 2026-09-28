/**
 * Server entry point.
 *
 * Handles start-up ordering (migrate → listen), graceful shutdown on SIGINT and
 * SIGTERM, and an uncaught-exception guard that logs before exiting so a crash
 * is never silent.
 */

import { buildApp } from './app.ts';

async function main(): Promise<void> {
  const tracker = await buildApp();

  const shutdown = async (signal: string): Promise<void> => {
    tracker.app.log.info({ signal }, 'shutting down');
    try {
      await tracker.close();
      process.exit(0);
    } catch (error) {
      tracker.app.log.error({ err: error }, 'error during shutdown');
      process.exit(1);
    }
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  process.on('unhandledRejection', (reason) => {
    tracker.app.log.error({ err: reason }, 'unhandled promise rejection');
  });
  process.on('uncaughtException', (error) => {
    tracker.app.log.fatal({ err: error }, 'uncaught exception');
    void shutdown('uncaughtException');
  });

  try {
    const address = await tracker.app.listen({
      host: tracker.config.host,
      port: tracker.config.port,
    });
    tracker.app.log.info(
      { address, env: tracker.config.env, database: tracker.config.databaseFile },
      'issue tracker listening',
    );

    // Ask the app, not the router. The SPA shell is served by the not-found
    // fallback, so `hasRoute({ url: '/' })` reports false even when the client
    // is being served — which made this line claim otherwise.
    if (tracker.servesWebClient) {
      tracker.app.log.info({ url: address }, 'web client is being served from this process');
    } else {
      tracker.app.log.info(
        { hint: 'npm run build --workspace @tracker/web' },
        'no built web client found; run the Vite dev server for the UI',
      );
    }
  } catch (error) {
    tracker.app.log.error({ err: error }, 'failed to start');
    process.exit(1);
  }
}

main().catch((error: unknown) => {
  // The logger does not exist yet if `buildApp` itself failed.
  process.stderr.write(`Fatal error during startup: ${String(error)}\n`);
  process.exit(1);
});
