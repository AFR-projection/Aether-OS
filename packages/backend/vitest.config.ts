import os from 'node:os';
import path from 'node:path';

import { defineConfig } from 'vitest/config';

/**
 * Test environment.
 *
 * `config.ts` validates `process.env` at import time and is frozen, so every
 * value the modules under test need must be present before the first import.
 * Setting them here — rather than in each test file — keeps that guarantee.
 * None of these are real credentials; the database URL is never connected to by
 * unit tests, which run without a database.
 */
const workspaceRoot = path.join(os.tmpdir(), 'aether-backend-tests', 'workspace');

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.spec.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/scripts/**', 'src/index.ts'],
    },
    env: {
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      LOG_FORMAT: 'json',
      // Vite injects its own `BASE_URL` (the deploy base path, `/` by default)
      // into the worker environment, which collides with the backend's
      // `BASE_URL` and fails URL validation. Setting it explicitly here wins.
      BASE_URL: 'http://localhost:3000',
      DATABASE_URL: 'postgresql://aether:unused@127.0.0.1:5432/aether_test',
      JWT_SECRET: 'test-only-jwt-secret-value-of-sufficient-length',
      ENCRYPTION_KEY: 'test-only-encryption-key-value-32-chars-min',
      AETHER_WORKSPACE_ROOT: workspaceRoot,
      // Enabled so the guard tests exercise the refusal paths rather than only
      // the "feature is off" branch. The tests never signal a live process:
      // they assert on the refusals that happen before any signal is sent.
      AETHER_PROCESS_SIGNAL_ENABLED: 'true',
    },
  },
});
