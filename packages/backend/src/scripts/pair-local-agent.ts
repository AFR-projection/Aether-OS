/**
 * Registers the host agent running on this same machine.
 *
 * Run by the installer, inside the backend container, once the stack is healthy
 * and the migrations have been applied:
 *
 *   docker compose run --rm --no-deps \
 *     -e AETHER_AGENT_ID=<uuid> \
 *     -e AETHER_AGENT_LABEL="Local host" \
 *     -e AETHER_AGENT_TOKEN_HASH=<sha256 hex> \
 *     --entrypoint node backend dist/scripts/pair-local-agent.js
 *
 * The installer owns token generation (it is the side that has to write the
 * plaintext into the agent's config), so only the hash crosses into the
 * backend. Exits non-zero on failure so the shell script can detect it.
 */
import { closePool } from '../db/pool.js';
import { registerLocalAgent } from '../services/agent-pairing.service.js';
import { logger } from '../utils/logger.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/i;

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is not set`);
  }
  return value;
}

async function main(): Promise<void> {
  const agentId = requireEnv('AETHER_AGENT_ID');
  const tokenHash = requireEnv('AETHER_AGENT_TOKEN_HASH');
  const label = process.env['AETHER_AGENT_LABEL']?.trim() || 'Local host';

  if (!UUID_PATTERN.test(agentId)) {
    throw new Error('AETHER_AGENT_ID must be a UUID');
  }
  if (!SHA256_HEX_PATTERN.test(tokenHash)) {
    throw new Error('AETHER_AGENT_TOKEN_HASH must be a SHA-256 digest in hex');
  }

  try {
    await registerLocalAgent({ agentId, label, tokenHash });
    logger.info({ agentId }, 'local host agent registered');
  } catch (error) {
    logger.fatal({ err: error, agentId }, 'could not register the local host agent');
    process.exitCode = 1;
  } finally {
    await closePool().catch(() => undefined);
  }
}

void main();
