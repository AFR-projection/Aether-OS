import { killAllSessions } from './capabilities/terminal.js';
import { loadConfig } from './config.js';
import { AgentConnection } from './connection.js';
import { createLogger, getLogger, logStartupConfiguration } from './logger.js';

function main(): void {
  const cfg = loadConfig();
  createLogger(cfg);
  logStartupConfiguration(cfg);

  const log = getLogger();

  const connection = new AgentConnection(cfg, {
    onHelloAck: (ownerUserId) => {
      log.info({ ownerUserId }, 'agent paired');
    },
    onClosed: (code, reason) => {
      log.info({ code, reason }, 'backend connection closed');
    },
  });

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info({ signal }, 'shutting down');

    try {
      await connection.stop();
    } catch (error) {
      log.warn({ err: error }, 'error stopping connection');
    }

    const killed = killAllSessions('shutdown');
    if (killed > 0) log.info({ killed }, 'terminal sessions killed');

    // Flush pino before exiting so the last lines are not lost.
    const logger = getLogger();
    await new Promise<void>((resolve) => {
      const flushable = logger as unknown as { flush(callback: () => void): void };
      if (typeof flushable.flush === 'function') {
        flushable.flush(() => resolve());
      } else {
        resolve();
      }
    });

    process.exit(0);
  };

  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));

  process.on('unhandledRejection', (reason) => {
    log.error({ err: reason }, 'unhandled rejection');
  });
  process.on('uncaughtException', (error) => {
    log.fatal({ err: error }, 'uncaught exception');
    void shutdown('uncaughtException');
  });

  connection.start();
  log.info('agent started');
}

try {
  main();
} catch (error: unknown) {
  // Logger may not exist yet if config failed; fall back to stderr and never
  // print the error object itself, which could contain secret material.
  // eslint-disable-next-line no-console
  console.error('Failed to start agent:', error instanceof Error ? error.message : 'unknown error');
  process.exit(1);
}
