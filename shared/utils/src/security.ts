import { logger } from "@devvir/service-kit";

const REDACTED = '*****';

/**
 * Replace the credentials of a URL with asterisks, for logging.
 *
 * Everything between the scheme and the last '@' is treated as credentials, so a password holding
 * raw characters a URL parser would split on ('@', ':', '/', '?', '#', '%') is redacted whole:
 * `amqp://user:p#ss@rabbitmq:5672/vhost` becomes `amqp://*****:*****@rabbitmq:5672/vhost`.
 * A URL without an '@' has no credentials and is returned as given. When the result does not
 * parse as a URL, or there is no scheme before the '@', the whole URL is replaced by asterisks. Neither the URL nor any part of it is ever logged.
 */
export const redactUrl = (url: string): string => {
  const redacted = withoutCredentials(url);
  const failure  = redacted === null ? 'no scheme before the credentials' : parseFailure(redacted);

  if (redacted !== null && failure === null) return redacted;

  logger.warn({ reason: failure }, 'URL does not parse, redacting it in full');

  return REDACTED;
};

/**
 * Percent-encode the username and password of a URL the WHATWG URL parser accepts.
 *
 * Handled: a raw '@' in the password (the parser splits userinfo from host at the last '@') and a
 * raw ':' in the password (the parser splits username from password at the first ':'). Sequences
 * that are already percent-encoded are decoded and re-encoded, so encoding is idempotent.
 *
 * Not handled: a raw '/', '?' or '#' in the credentials, which the parser reads as the start of a
 * path, query or fragment, and a ':' in the username, which it reads as the start of the password.
 * Such credentials come out split wrongly, or the URL does not parse. A URL that does not parse, or
 * whose credentials hold a '%' not followed by two hex digits, is returned unchanged. Nothing is
 * logged.
 */
export const sanitizeUrl = (url: string): string => {
  try {
    const urlObj = new URL(url);

    if (urlObj.username) urlObj.username = encodeURIComponent(decodeURIComponent(urlObj.username));
    if (urlObj.password) urlObj.password = encodeURIComponent(decodeURIComponent(urlObj.password));

    return urlObj.toString();
  } catch {
    return url;
  }
};

/** The URL with everything between its scheme and its last '@' redacted, or null without a scheme. */
const withoutCredentials = (url: string): string | null => {
  const at = url.lastIndexOf('@');

  if (at === -1) return url;

  const scheme = /^\s*[a-z][a-z0-9+.-]*:(?:\/\/)?/i.exec(url)?.[0];

  return scheme !== undefined && scheme.length <= at
    ? `${scheme}${REDACTED}:${REDACTED}${url.slice(at)}`
    : null;
};

/** Why a URL does not parse, as an error code or name (never the URL), or null when it does. */
const parseFailure = (url: string): string | null => {
  try {
    new URL(url);
    return null;
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code ?? (error as Error)?.name ?? 'unparsable';
  }
};
