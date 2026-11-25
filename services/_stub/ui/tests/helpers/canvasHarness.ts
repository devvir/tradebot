/**
 * jsdom harness for mounting a canvas widget with a real layout size and
 * driving it with pointer and wheel events.
 *
 *   installCanvasHarness()  — call in beforeEach; returns the shared 2D context
 *                             mock and undoes itself in the returned restore().
 *   pointer(el, type, init) — dispatch a pointer event (jsdom has no PointerEvent,
 *                             so it is a MouseEvent carrying a pointerId).
 *   wheel(el, init)         — dispatch a cancelable WheelEvent.
 *
 * The ResizeObserver stand-in reports a `width` x `height` content box as soon
 * as an element is observed. getBoundingClientRect() stays jsdom's all-zero
 * rect, so clientX equals the canvas-local x.
 */

import { vi } from 'vitest';

export interface CanvasHarness {
  ctx:                    Record<string, ReturnType<typeof vi.fn>>;
  setPointerCapture:      ReturnType<typeof vi.fn>;
  releasePointerCapture:  ReturnType<typeof vi.fn>;
  restore:                () => void;
}

const CTX_METHODS = [
  'fillRect', 'clearRect', 'beginPath', 'closePath', 'moveTo', 'lineTo', 'arc', 'stroke', 'fill',
  'fillText', 'strokeText', 'save', 'restore', 'scale', 'rotate', 'translate', 'setTransform',
  'resetTransform', 'setLineDash', 'drawImage', 'putImageData',
];

export function installCanvasHarness(
  { width, height, dpr = 1 }: { width: number; height: number; dpr?: number },
): CanvasHarness {
  vi.stubGlobal('ResizeObserver', class {
    constructor(private readonly cb: ResizeObserverCallback) {}

    observe(target: Element) {
      this.cb([{ target, contentRect: { width, height } } as unknown as ResizeObserverEntry], this as unknown as ResizeObserver);
    }

    unobserve()  {}
    disconnect() {}
  });

  vi.stubGlobal('devicePixelRatio', dpr);

  const ctx: Record<string, ReturnType<typeof vi.fn>> = {};

  for (const m of CTX_METHODS) {
    ctx[m] = vi.fn();
  }

  ctx.measureText = vi.fn(() => ({ width: 0 }));

  const getContext = vi.spyOn(HTMLCanvasElement.prototype, 'getContext')
    .mockReturnValue(ctx as unknown as CanvasRenderingContext2D);

  const proto = HTMLCanvasElement.prototype as unknown as Record<string, unknown>;
  const saved = { set: proto.setPointerCapture, release: proto.releasePointerCapture };

  const setPointerCapture     = vi.fn();
  const releasePointerCapture = vi.fn();

  proto.setPointerCapture     = setPointerCapture;
  proto.releasePointerCapture = releasePointerCapture;

  return {
    ctx,
    setPointerCapture,
    releasePointerCapture,
    restore() {
      vi.unstubAllGlobals();
      getContext.mockRestore();
      proto.setPointerCapture     = saved.set;
      proto.releasePointerCapture = saved.release;
    },
  };
}

export function pointer(
  el:   Element,
  type: 'pointerdown' | 'pointermove' | 'pointerup' | 'pointercancel' | 'pointerleave',
  init: MouseEventInit & { pointerId?: number } = {},
): MouseEvent {
  const { pointerId = 1, ...mouse } = init;
  const e = new MouseEvent(type, { bubbles: true, ...mouse });

  Object.defineProperty(e, 'pointerId', { value: pointerId });
  el.dispatchEvent(e);

  return e;
}

export function wheel(el: Element, init: WheelEventInit): WheelEvent {
  const e = new WheelEvent('wheel', { cancelable: true, ...init });

  el.dispatchEvent(e);

  return e;
}
