import { closeAllTunnels } from './capabilities/port-tunnel.js';
import { endAllUnits } from './capabilities/units.js';
import { loadConfig } from './config.js';
import { AgentConnection } from './connection.js';
import { createLogger, getLogger, logStartupConfiguration } from './logger.js';

/**
 * How long shutdown waits for units to exit before giving up on them.
 *
 * Short, and shorter than a unit's own grace period: the agent is on its way
 * out, every unit has already been sent `SIGTERM` and armed with its own
 * escalation to `SIGKILL`, and a process that cannot stop the agent from
 * exiting must not be able to hold the service open past systemd's patience.
 */
const SHUTDOWN_GRACE_MS = 3_000;

/** Runs `work` but stops waiting after `ms`. Never rejects. */
async function withTimeout(work: Promise<number>, ms: number): Promise<number> {
  return Promise.race([
    work.catch(() => 0),
    new Promise<number>((resolve) => {
      const timer = setTimeout(() => resolve(-1), ms);
      timer.unref();
    }),
  ]);
}

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

    // Every unit, not only the terminals: a command unit is a process on this
    // machine too, and an agent that exited leaving one behind would have
    // orphaned it. The wait is bounded — a child that ignores SIGTERM must not
    // be able to hold the agent open, and every unit has already been armed
    // with its own escalation to SIGKILL.
    const ended = await withTimeout(endAllUnits('shutdown'), SHUTDOWN_GRACE_MS);
    log.info({ ended }, 'execution units ended');

    // A tunnel is a live socket to a service on this machine. Closing it here
    // rather than relying on process exit means an orderly restart does not
    // leave half-open connections on whatever the user was previewing.
    closeAllTunnels();

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
