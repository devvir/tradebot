import type { BitmexTable } from '../types';
import type { TableHandler } from './handler';

import { instrumentHandler          } from './ws/instrument';
import { orderBookL2Handler         } from './ws/orderBookL2';
import { orderBookL2_25Handler      } from './ws/orderBookL2_25';
import { orderBook10Handler         } from './ws/orderBook10';
import { liquidationHandler         } from './ws/liquidation';
import { announcementHandler        } from './ws/announcement';
import { chatHandler                } from './ws/chat';
import { connectedHandler           } from './ws/connected';
import { publicNotificationsHandler } from './ws/publicNotifications';

import { tradeHandler        } from './rest/trade';
import { quoteHandler        } from './rest/quote';
import { fundingHandler      } from './rest/funding';
import { settlementHandler   } from './rest/settlement';
import { insuranceHandler    } from './rest/insurance';
import {
  tradeBin1mHandler,
  tradeBin5mHandler,
  tradeBin1hHandler,
  tradeBin1dHandler,
} from './rest/tradeBin';
import {
  quoteBin1mHandler,
  quoteBin5mHandler,
  quoteBin1hHandler,
  quoteBin1dHandler,
} from './rest/quoteBin';

/**
 * Registry of every table digger can replay.
 *
 *   9 WS-origin   — stored as full WS messages, republished by stripping `_id`.
 *   13 REST-origin — stored as flat records, wrapped as single-item inserts.
 */
export const TABLE_HANDLERS: Partial<Record<BitmexTable, TableHandler>> = {
  // WS-origin
  instrument:          instrumentHandler,
  orderBookL2:         orderBookL2Handler,
  orderBookL2_25:      orderBookL2_25Handler,
  orderBook10:         orderBook10Handler,
  liquidation:         liquidationHandler,
  announcement:        announcementHandler,
  chat:                chatHandler,
  connected:           connectedHandler,
  publicNotifications: publicNotificationsHandler,

  // REST-origin
  trade:               tradeHandler,
  quote:               quoteHandler,
  funding:             fundingHandler,
  settlement:          settlementHandler,
  insurance:           insuranceHandler,
  tradeBin1m:          tradeBin1mHandler,
  tradeBin5m:          tradeBin5mHandler,
  tradeBin1h:          tradeBin1hHandler,
  tradeBin1d:          tradeBin1dHandler,
  quoteBin1m:          quoteBin1mHandler,
  quoteBin5m:          quoteBin5mHandler,
  quoteBin1h:          quoteBin1hHandler,
  quoteBin1d:          quoteBin1dHandler,
};

/** True if `table` has a registered handler. */
export const isSupportedTable = (table: string): table is BitmexTable =>
  table in TABLE_HANDLERS;
