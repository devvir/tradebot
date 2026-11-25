import type { Candle, ChartDimensions } from './types';
import { fmtPrice, MAX_PRICE_DECIMALS } from '../../utils/format';

// ── Layout constants ──────────────────────────────────────────────────────────

/** Space around the plot area, in logical pixels. The right margin holds the price axis. */
export const MARGIN = { top: 8, right: 66, bottom: 22, left: 0 };

/** Volume pane as a fraction of the total plot height. */
const VOL_RATIO = 0.18;

/** Vertical gap in px between the price pane and the volume pane. */
const VOL_GAP = 4;

/** Vertical padding added above/below the price range as a fraction of that range. */
const PRICE_PAD = 0.05;

// ── Theme ─────────────────────────────────────────────────────────────────────

const C = {
  bg:      '#080808',
  grid:    '#1d2631',
  text:    '#a6adba',
  up:      '#0a9b62',
  down:    '#fe3c3c',
  volUp:   'rgba(10,155,98,0.45)',
  volDown: 'rgba(254,60,60,0.45)',
  cross:   'rgba(166,173,186,0.55)',
} as const;

// ── Horizontal geometry ───────────────────────────────────────────────────────

/**
 * Horizontal layout of the candle slots: the plot is divided into
 * max(candlesPerView, count) equal slots and candles fill them from the
 * right edge, so the newest candle is always rightmost and a candle's width
 * depends only on the zoom level, not on how many candles are loaded.
 */
export interface ColumnGeometry {
  /** Logical x of the plot's right edge. */
  plotRight: number;
  /** Logical width of one candle slot. */
  step:      number;
  /** Number of candles laid out. */
  count:     number;
}

/** Slot layout for `count` candles at a zoom of `candlesPerView`, in a canvas `width` wide. */
export function columnGeometry(width: number, count: number, candlesPerView: number): ColumnGeometry {
  const plotW = Math.max(1, width - MARGIN.left - MARGIN.right);

  return {
    plotRight: MARGIN.left + plotW,
    step:      plotW / Math.max(1, candlesPerView, count),
    count,
  };
}

/** Logical x of the centre of candle `i`. */
export function columnCenterX(g: ColumnGeometry, i: number): number {
  return g.plotRight - (g.count - i) * g.step + g.step / 2;
}

/** Index of the candle whose slot contains logical x, or null if no candle is there. */
export function columnAt(g: ColumnGeometry, x: number): number | null {
  if (x >= g.plotRight) {
    return null;
  }

  const idx = g.count - 1 - Math.floor((g.plotRight - x) / g.step);

  return idx >= 0 && idx < g.count ? idx : null;
}

// ── Public entry point ────────────────────────────────────────────────────────

/**
 * Renders the full chart into `ctx` at the given logical pixel dimensions.
 * ctx.setTransform() must have already been applied for DPR scaling before
 * this is called — this function always works in logical (CSS) pixels.
 *
 * Candle timestamps are bin close times; `binMs` is the bin duration, used to
 * label the time axis with bin open times.
 *
 * Sections:
 *   1. Clear
 *   2. Compute geometry and scales
 *   3. Horizontal price grid
 *   4. Price axis labels
 *   5. Candlestick bodies + wicks
 *   6. Volume bars
 *   7. Time axis labels
 *   8. Hover crosshair
 */
export function renderChart(
  ctx:            CanvasRenderingContext2D,
  candles:        Candle[],
  dim:            ChartDimensions,
  candlesPerView: number,
  binMs:          number,
  hoverIndex:     number | null = null,
): void {
  const { width, height } = dim;

  ctx.fillStyle = C.bg;
  ctx.fillRect(0, 0, width, height);

  if (candles.length === 0) {
    return;
  }

  // ── Geometry ────────────────────────────────────────────────────────────────

  const plotH  = height - MARGIN.top  - MARGIN.bottom;
  const chartH = Math.round(plotH * (1 - VOL_RATIO));
  const volH   = plotH - chartH - VOL_GAP;

  const priceTop = MARGIN.top;
  const priceBot = MARGIN.top + chartH;
  const volTop   = priceBot + VOL_GAP;
  const volBot   = volTop + volH;

  // ── Scales ──────────────────────────────────────────────────────────────────

  const highs    = candles.map(c => c.high);
  const lows     = candles.map(c => c.low);
  const priceMax = Math.max(...highs);
  const priceMin = Math.min(...lows);
  const range    = priceMax - priceMin || 1;
  const pad      = range * PRICE_PAD;
  const yMax     = priceMax + pad;
  const yMin     = priceMin - pad;
  const volMax   = Math.max(...candles.map(c => c.volume), 1);

  function priceToY(price: number): number {
    return priceTop + (1 - (price - yMin) / (yMax - yMin)) * chartH;
  }

  const columns = columnGeometry(width, candles.length, candlesPerView);
  const bodyW   = Math.max(2, columns.step - 1);
  const halfW   = Math.max(1, Math.floor(bodyW / 2));

  function centerX(i: number): number {
    return columnCenterX(columns, i);
  }

  // ── 3. Horizontal price grid ─────────────────────────────────────────────────

  const priceStep  = niceStep(yMax - yMin, 5);
  const firstPrice = Math.ceil(yMin / priceStep) * priceStep;

  ctx.strokeStyle = C.grid;
  ctx.lineWidth   = 1;

  for (let p = firstPrice; p <= yMax; p += priceStep) {
    const y = Math.round(priceToY(p)) + 0.5;
    ctx.beginPath();
    ctx.moveTo(MARGIN.left, y);
    ctx.lineTo(width - MARGIN.right, y);
    ctx.stroke();
  }

  // ── 4. Price axis labels ──────────────────────────────────────────────────────

  ctx.fillStyle    = C.text;
  ctx.font         = '10px -apple-system, BlinkMacSystemFont, sans-serif';
  ctx.textAlign    = 'left';
  ctx.textBaseline = 'middle';

  for (let p = firstPrice; p <= yMax; p += priceStep) {
    ctx.fillText(
      formatPrice(p, priceStep),
      width - MARGIN.right + 4,
      priceToY(p),
    );
  }

  // ── 5. Candlestick wicks + bodies ────────────────────────────────────────────

  for (let i = 0; i < candles.length; i++) {
    const c     = candles[i];
    const cx    = centerX(i);
    const up    = c.close >= c.open;
    const color = up ? C.up : C.down;

    const yHigh  = priceToY(c.high);
    const yLow   = priceToY(c.low);
    const yOpen  = priceToY(c.open);
    const yClose = priceToY(c.close);
    const bodyT  = Math.min(yOpen, yClose);
    const bodyH  = Math.max(1, Math.abs(yClose - yOpen));

    ctx.strokeStyle = color;
    ctx.fillStyle   = color;
    ctx.lineWidth   = 1;

    // Wick
    ctx.beginPath();
    ctx.moveTo(cx, yHigh);
    ctx.lineTo(cx, yLow);
    ctx.stroke();

    // Body
    ctx.fillRect(cx - halfW, bodyT, halfW * 2, bodyH);
  }

  // ── 6. Volume bars ────────────────────────────────────────────────────────────

  const volPaneH = volBot - volTop;

  for (let i = 0; i < candles.length; i++) {
    const c   = candles[i];
    const cx  = centerX(i);
    const up  = c.close >= c.open;
    const barH = Math.max(1, (c.volume / volMax) * volPaneH);

    ctx.fillStyle = up ? C.volUp : C.volDown;
    ctx.fillRect(cx - halfW, volBot - barH, halfW * 2, barH);
  }

  // ── 7. Time axis labels ───────────────────────────────────────────────────────

  drawTimeAxis(ctx, candles, binMs, height, centerX);

  // ── 8. Hover crosshair ────────────────────────────────────────────────────────

  if (hoverIndex !== null && hoverIndex >= 0 && hoverIndex < candles.length) {
    const x = Math.round(centerX(hoverIndex)) + 0.5;

    ctx.save();
    ctx.strokeStyle = C.cross;
    ctx.lineWidth   = 1;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(x, MARGIN.top);
    ctx.lineTo(x, height - MARGIN.bottom);
    ctx.stroke();
    ctx.restore();
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Draws time labels at the bottom, at most one per 60px. Each label is its
 * candle's bin open time: the date for a bin opening at midnight UTC, else HH:MM.
 */
function drawTimeAxis(
  ctx:     CanvasRenderingContext2D,
  candles: Candle[],
  binMs:   number,
  height:  number,
  centerX: (i: number) => number,
): void {
  const y = height - MARGIN.bottom + 4;

  ctx.fillStyle    = C.text;
  ctx.font         = '10px -apple-system, BlinkMacSystemFont, sans-serif';
  ctx.textAlign    = 'center';
  ctx.textBaseline = 'top';

  let lastLabelX = -999;

  for (let i = 0; i < candles.length; i++) {
    const cx = centerX(i);

    if (cx - lastLabelX < 60) {
      continue;
    }

    const d    = new Date(new Date(candles[i].timestamp).getTime() - binMs);
    const mins = d.getUTCMinutes();
    const hrs  = d.getUTCHours();

    const label = mins === 0 && hrs === 0
      ? d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })
      : d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'UTC' });

    ctx.fillText(label, cx, y);
    lastLabelX = cx;
  }
}

/** Computes a round step for axis labels that gives roughly `ticks` intervals. */
function niceStep(range: number, ticks: number): number {
  const raw  = range / ticks;
  const exp  = Math.floor(Math.log10(raw));
  const mag  = Math.pow(10, exp);
  const frac = raw / mag;
  const nice = frac < 1.5 ? 1 : frac < 3 ? 2 : frac < 7 ? 5 : 10;

  return nice * mag;
}

/**
 * Axis label for price `p` on an axis whose labels are `step` apart, with just
 * enough fraction digits to tell neighbours apart (step 0.2 → 1, step 5 → 0).
 */
function formatPrice(p: number, step: number): string {
  const decimals = Math.min(MAX_PRICE_DECIMALS, Math.max(0, -Math.floor(Math.log10(step))));

  return fmtPrice(p, decimals);
}

// ── Test-only exports ─────────────────────────────────────────────────────────

export const _test_niceStep    = niceStep;
export const _test_formatPrice = formatPrice;
