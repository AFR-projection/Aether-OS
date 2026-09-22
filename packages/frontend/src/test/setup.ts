import '@testing-library/jest-dom/vitest';

import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

/**
 * Test setup, loaded before every frontend suite.
 *
 * `@testing-library/jest-dom/vitest` adds the DOM matchers (`toBeVisible`,
 * `toHaveTextContent`, …) to `expect`. `cleanup` unmounts anything a test
 * rendered so the next test starts against an empty document — without it,
 * `render` appends to the same `body` and queries match the wrong instance.
 */
afterEach(() => {
  cleanup();
});

/**
 * jsdom does not implement `matchMedia`, `ResizeObserver` or `scrollTo`, and
 * several components read them at mount. Stub them to inert defaults so a render
 * does not throw on a capability the test is not about. Each is the minimum
 * shape its callers use, not a full polyfill.
 */
if (typeof window !== 'undefined') {
  if (!window.matchMedia) {
    window.matchMedia = (query: string): MediaQueryList =>
      ({
        matches: false,
        media: query,
        onchange: null,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
        addListener: () => undefined,
        removeListener: () => undefined,
        dispatchEvent: () => false,
      }) as unknown as MediaQueryList;
  }

  if (!('ResizeObserver' in window)) {
    class ResizeObserverStub {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    }
    (window as unknown as { ResizeObserver: unknown }).ResizeObserver = ResizeObserverStub;
  }

  if (!window.scrollTo) {
    window.scrollTo = (() => undefined) as typeof window.scrollTo;
  }
}
