import type { paths, operations } from '@devvir/bitmex-api/types';
import {
  OrderBookGetL2QueryParams,
  TradeGetQueryParams,
  QuoteGetQueryParams,
  InstrumentGetQueryParams,
  SettlementGetQueryParams,
  ExecutionGetQueryParams,
  ExecutionGetTradeHistoryQueryParams,
  FundingGetQueryParams,
  PositionGetQueryParams,
  UserGetMarginQueryParams,
  UserGetWalletQueryParams,
  UserGetWalletHistoryQueryParams,
  UserGetWalletSummaryQueryParams,
  UserGetDepositAddressQueryParams,
  UserEventGetQueryParams,
  OrderGetOrdersQueryParams,
} from '@devvir/bitmex-api/schemas';

export interface Config {
  snapshotsUrl: string;
  [key: string]: unknown;
}

export {
  OrderBookGetL2QueryParams as OrderBookQuerySchema,
  TradeGetQueryParams as TradeQuerySchema,
  QuoteGetQueryParams as QuoteQuerySchema,
  InstrumentGetQueryParams as InstrumentQuerySchema,
  SettlementGetQueryParams,
  ExecutionGetQueryParams,
  ExecutionGetTradeHistoryQueryParams,
  FundingGetQueryParams,
  PositionGetQueryParams,
  UserGetMarginQueryParams,
  UserGetWalletQueryParams,
  UserGetWalletHistoryQueryParams,
  UserGetWalletSummaryQueryParams,
  UserGetDepositAddressQueryParams,
  UserEventGetQueryParams,
  OrderGetOrdersQueryParams,
};

export type { paths, operations };
