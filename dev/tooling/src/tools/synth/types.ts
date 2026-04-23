export interface PriceLevel {
  _id: number;
  symbol: string;
  price: number;
}

/** A single proven OB fact derived from a real trade. */
export interface ObFact {
  /** trdMatchID from the source trade — ensures idempotent re-runs. */
  _id: string;
  timestamp: string;
  symbol: string;
  /** Resting order side (opposite of trade taker side). */
  side: 'Buy' | 'Sell';
  price: number;
  size: number;
}

export type SynthSubcommand = 'levels' | 'stage1' | 'calibrate';
