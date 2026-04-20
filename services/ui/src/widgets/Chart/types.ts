export type Timeframe = '1m' | '5m' | '1h' | '1d';

export interface Candle {
  timestamp: string;
  open:      number;
  high:      number;
  low:       number;
  close:     number;
  volume:    number;
}

/** Logical pixel dimensions of the canvas draw surface. */
export interface ChartDimensions {
  width:  number;
  height: number;
}

/**
 * Viewport describes what to show: how many candles fit horizontally
 * (candlesPerView) and the timestamp of the rightmost visible candle
 * (rightAnchor). rightAnchor === null means live mode — the right edge
 * follows the latest candle as new data arrives.
 */
export interface ViewportState {
  candlesPerView: number;
  rightAnchor:    Date | null;
}

/** Duration of one bin, in milliseconds. Converts between candle counts and time. */
export const BIN_MS: Record<Timeframe, number> = {
  '1m':      60 * 1000,
  '5m':  5 * 60 * 1000,
  '1h': 60 * 60 * 1000,
  '1d': 24 * 60 * 60 * 1000,
};
