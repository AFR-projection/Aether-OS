import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

/**
 * Vitest configuration for the frontend.
 *
 * Kept separate from `vite.config.ts` on purpose: the build config carries
 * Monaco worker handling, manual chunking and a dev proxy that a test run has
 * no use for, and pulling the test environment into it would make every `vite
 * build` parse jsdom options it never reads. This file exists to answer one
 * question — how the window manager and its components are exercised without a
 * browser — and nothing else.
 *
 * `jsdom` gives the components a DOM to render into; `globals` lets the suites
 * read like the backend's (no `import { describe }` boilerplate); the setup file
 * installs `@testing-library/jest-dom`'s matchers and resets the DOM between
 * tests so one component's render cannot leak into the next.
 */
export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    css: false,
    // The store test is DOM-free and the component tests need jsdom; both run
    // under one environment rather than splitting the suite.
    include: ['src/**/*.test.{ts,tsx}'],
    restoreMocks: true,
  },
});
