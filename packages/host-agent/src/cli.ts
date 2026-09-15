#!/usr/bin/env node
/**
 * `aether-agent` CLI.
 *
 * `start` runs the agent in the foreground. `pair` prints the pairing values
 * the backend issued and verifies they parse, so an operator can confirm the
 * environment is correct before starting the service. `status` reports whether
 * the required environment is present without starting anything.
 */

import { randomUUID } from 'node:crypto';

const USAGE = `aether-agent <command>

Commands:
  start    Run the agent (reads AETHER_BACKEND_URL, AETHER_PAIRING_TOKEN, AETHER_AGENT_ID)
  pair     Print pairing checklist and validate the current environment
  status   Report whether the agent is configured correctly
  gen-id   Print a fresh agent id (uuid) for use as AETHER_AGENT_ID
`;

function command(): string | undefined {
  return process.argv[2];
}

function checkEnv(): { ok: boolean; problems: string[] } {
  const problems: string[] = [];
  const url = process.env.AETHER_BACKEND_URL;
  const token = process.env.AETHER_PAIRING_TOKEN;
  const agentId = process.env.AETHER_AGENT_ID;

  if (!url) {
    problems.push('AETHER_BACKEND_URL is not set (e.g. wss://aether.example.com)');
  } else {
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') {
        problems.push('AETHER_BACKEND_URL must use the ws: or wss: scheme');
      }
    } catch {
      problems.push('AETHER_BACKEND_URL is not a valid URL');
    }
  }

  if (!token) {
    problems.push('AETHER_PAIRING_TOKEN is not set (issue one from the backend first)');
  } else if (token.length < 16) {
    problems.push('AETHER_PAIRING_TOKEN is too short (minimum 16 characters)');
  }

  if (!agentId) {
    problems.push('AETHER_AGENT_ID is not set (run `aether-agent gen-id` to create one)');
  } else if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(agentId)) {
    problems.push('AETHER_AGENT_ID is not a valid UUID');
  }

  return { ok: problems.length === 0, problems };
}

async function main(): Promise<void> {
  const cmd = command();

  if (cmd === 'gen-id') {
    // eslint-disable-next-line no-console
    console.log(randomUUID());
    return;
  }

  if (cmd === 'status' || cmd === 'pair') {
    const { ok, problems } = checkEnv();
    if (ok) {
      // eslint-disable-next-line no-console
      console.log('Agent environment looks good.');
      if (cmd === 'pair') {
        // eslint-disable-next-line no-console
        console.log('Next: run `aether-agent start` with the same environment.');
      }
      return;
    }
    // eslint-disable-next-line no-console
    console.error('Agent environment problems:');
    for (const problem of problems) {
      // eslint-disable-next-line no-console
      console.error(`  - ${problem}`);
    }
    process.exitCode = 1;
    return;
  }

  if (cmd === 'start' || cmd === undefined) {
    const { problems } = checkEnv();
    if (problems.length > 0) {
      // Fail fast with the checklist rather than a zod dump.
      for (const problem of problems) {
        // eslint-disable-next-line no-console
        console.error(`  - ${problem}`);
      }
      process.exitCode = 1;
      return;
    }
    await import('./index.js');
    return;
  }

  // eslint-disable-next-line no-console
  console.error(`Unknown command: ${cmd}\n\n${USAGE}`);
  process.exitCode = 1;
}

void main().catch((error: unknown) => {
  // eslint-disable-next-line no-console
  console.error('Agent failed:', error instanceof Error ? error.message : 'unknown error');
  process.exit(1);
});
