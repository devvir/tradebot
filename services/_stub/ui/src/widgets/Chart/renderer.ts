import type { Candle, ChartDimensions } from './types';

// ── Layout constants ──────────────────────────────────────────────────────────

/**
 * Exported so gesture handlers (ChartCanvas) can compute the plot width for
 * converting pixel deltas to candle deltas.
 */
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

// ── Public entry point ────────────────────────────────────────────────────────

/**
 * Renders the full chart into `ctx` at the given logical pixel dimensions.
 * ctx.setTransform() must have already been applied for DPR scaling before
 * this is called — this function always works in logical (CSS) pixels.
 *
 * Sections (easy to split into separate renderers as the chart grows):
 *   1. Clear
 *   2. Compute scales
 *   3. Horizontal price grid
 *   4. Price axis labels
 *   5. Candlestick bodies + wicks
 *   6. Volume bars
 *   7. Time axis labels
 */
export function renderChart(
  ctx:        CanvasRenderingContext2D,
  candles:    Candle[],
  dim:        ChartDimensions,
  hoverIndex: number | null = null,
): void {
  const { width, height } = dim;

  ctx.fillStyle = C.bg;
  ctx.fillRect(0, 0, width, height);

  if (candles.length === 0) {
    return;
  }

  // ── Geometry ────────────────────────────────────────────────────────────────

  const plotW  = width  - MARGIN.left - MARGIN.right;
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

  const step  = plotW / candles.length;
  const bodyW = Math.max(2, step - 1);
  const halfW = Math.max(1, Math.floor(bodyW / 2));

  function centerX(i: number): number {
    return MARGIN.left + i * step + step / 2;
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
      formatPrice(p),
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

  drawTimeAxis(ctx, candles, width, height, centerX);

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
 * Draws time labels at the bottom. Labels are placed at candles where the
 * hour or day boundary changes, spaced at least 60px apart.
 */
function drawTimeAxis(
  ctx:     CanvasRenderingContext2D,
  candles: Candle[],
  _width:  number,
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

    const d    = new Date(candles[i].timestamp);
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

function formatPrice(p: number): string {
  const decimals = p < 10 ? 4 : p < 100 ? 2 : 0;

  return p.toLocaleString('en-US', {
    minimumFractionDigits:  decimals,
    maximumFractionDigits:  decimals,
  });
}
