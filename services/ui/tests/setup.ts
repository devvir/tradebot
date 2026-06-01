/**
 * Global test setup: jest-dom matchers + a default value for the build-time
 * `__REPLAY_ENABLED__` flag (vite's `define` doesn't apply in tests, so the
 * bare global reference resolves via `globalThis`). Individual tests can
 * override by reassigning `globalThis.__REPLAY_ENABLED__`.
 */

import '@testing-library/jest-dom/vitest';
import { vi } from 'vitest';

declare global {
  // eslint-disable-next-line no-var
  var __REPLAY_ENABLED__: boolean;
}

globalThis.__REPLAY_ENABLED__ = true;

// ── jsdom polyfills ───────────────────────────────────────────────────────────

/** `react-grid-layout` and other libs rely on ResizeObserver; jsdom has none. */
class ResizeObserverStub {
  observe()    {}
  unobserve()  {}
  disconnect() {}
}

globalThis.ResizeObserver ??= ResizeObserverStub as unknown as typeof ResizeObserver;

/** jsdom's canvas throws on getContext — return a no-op context so widgets
 *  that draw (ChartCanvas) can mount without crashing. */
HTMLCanvasElement.prototype.getContext = vi.fn(() => ({
  fillRect:        () => {},
  clearRect:       () => {},
  beginPath:       () => {},
  closePath:       () => {},
  moveTo:          () => {},
  lineTo:          () => {},
  arc:             () => {},
  stroke:          () => {},
  fill:            () => {},
  fillText:        () => {},
  strokeText:      () => {},
  measureText:     () => ({ width: 0 }),
  save:            () => {},
  restore:         () => {},
  scale:           () => {},
  rotate:          () => {},
  translate:       () => {},
  setTransform:    () => {},
  resetTransform:  () => {},
  setLineDash:     () => {},
  drawImage:       () => {},
  createImageData: () => ({ data: new Uint8ClampedArray() }),
  putImageData:    () => {},
  getImageData:    () => ({ data: new Uint8ClampedArray() }),
})) as unknown as typeof HTMLCanvasElement.prototype.getContext;
