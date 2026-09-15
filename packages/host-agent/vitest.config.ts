import os from 'node:os';
import path from 'node:path';

import { defineConfig } from 'vitest/config';

const workspaceRoot = path.join(os.tmpdir(), 'aether-agent-tests', 'workspace');

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.spec.ts'],
    env: {
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      AETHER_BACKEND_URL: 'ws://127.0.0.1:9',
      AETHER_PAIRING_TOKEN: 'test-only-pairing-token',
      AETHER_AGENT_ID: '00000000-0000-4000-8000-000000000000',
      AETHER_WORKSPACE_ROOT: workspaceRoot,
      PROCESS_SIGNAL_ENABLED: 'true',
    },
  },
});
