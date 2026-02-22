import { logger } from "@devvir/service";

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
