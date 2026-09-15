import { QueryClientProvider } from '@tanstack/react-query';
import { createRoot } from 'react-dom/client';

import { App } from './App.js';
import { queryClient } from './lib/query-client.js';

import './index.css';

/**
 * Entry point.
 *
 * StrictMode is deliberately off. Its double-invoked effects are harmless in
 * most apps, but here each Terminal window mount creates a real server-side PTY
 * session — mounting twice would spawn two shells for one window. The terminal
 * guards against this as well, but not double-mounting is the cleaner rule.
 */

const root = document.getElementById('root');
if (root === null) {
  throw new Error('Missing #root element');
}

createRoot(root).render(
  <QueryClientProvider client={queryClient}>
    <App />
  </QueryClientProvider>
);
