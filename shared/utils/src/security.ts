import { logger } from "@devvir/service-kit";

/**
 * Replace credentials in a URL with asterisks for safe logging.
 */
export const redactUrl = (url: string): string => {
  try {
    const urlObj = new URL(url);

    if (urlObj.username || urlObj.password) {
      urlObj.username = '*****';
      urlObj.password = '*****';
    }

    return urlObj.toString();
  } catch (error) {
    logger.warn({ error, url }, 'Failed to redact credentials, redacting URL in full');
    return '*****';
  }
};

/**
 * Properly encode special characters in MongoDB/AMQP connection URLs.
 * Credentials must be URL-encoded to handle special characters like @, :, /, etc.
 */
export const sanitizeUrl = (url: string): string => {
  try {
    var urlObj = new URL(url);

    if (urlObj.username) urlObj.username = encodeURIComponent(decodeURIComponent(urlObj.username));
    if (urlObj.password) urlObj.password = encodeURIComponent(decodeURIComponent(urlObj.password));
  } catch (error) {
    logger.warn({ error, url }, 'Failed to parse URL, using as-is');
    return url;
  }

  return urlObj.toString();
};

/**
 * Replace credentials in a URL with asterisks for safe logging.
 */
export const redactCredentials = (original: string, length: number = 5): string => {
  return original.slice(0, length) + '*****';
};

export type AccountType = 'live' | 'testnet' | 'replay';

export interface EnvironmentUrls {
  wsUrl:         string;
  wsPlatformUrl: string;
  restUrl:       string;
}

const BITMEX_URLS: Record<AccountType, EnvironmentUrls> = {
  live: {
    wsUrl:         'wss://www.bitmex.com/realtime',
    wsPlatformUrl: 'wss://www.bitmex.com/realtimePlatform',
    restUrl:       'https://www.bitmex.com/api/v1',
  },
  testnet: {
    wsUrl:         'wss://testnet.bitmex.com/realtime',
    wsPlatformUrl: 'wss://testnet.bitmex.com/realtimePlatform',
    restUrl:       'https://testnet.bitmex.com/api/v1',
  },
  replay: {
    wsUrl:         'wss://ws/realtime',
    wsPlatformUrl: 'wss://ws/realtimePlatform',
    restUrl:       'http://rest/api/v1',
  },
};

export function resolveBitmexUrls(type: AccountType): EnvironmentUrls {
  return BITMEX_URLS[type];
}
