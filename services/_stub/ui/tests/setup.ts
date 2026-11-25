/**
 * Global test setup: jest-dom matchers and the browser APIs jsdom lacks.
 */

import '@testing-library/jest-dom/vitest';

// ── jsdom polyfills ───────────────────────────────────────────────────────────

/** `react-grid-layout` relies on ResizeObserver; jsdom has none. */
class ResizeObserverStub {
  observe()    {}
  unobserve()  {}
  disconnect() {}
}

globalThis.ResizeObserver ??= ResizeObserverStub as unknown as typeof ResizeObserver;
