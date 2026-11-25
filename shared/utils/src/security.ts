import { logger } from "@devvir/service-kit";

const REDACTED = '*****';

/**
 * Replace the credentials of a URL with asterisks, for logging.
 *
 * Everything between the scheme and the last '@' is treated as credentials, so a password holding
 * raw characters a URL parser would split on ('@', ':', '/', '?', '#', '%') is redacted whole:
 * `amqp://user:p#ss@rabbitmq:5672/vhost` becomes `amqp://*****:*****@rabbitmq:5672/vhost`.
 * A URL without an '@' has no credentials and is returned as given. When the result does not
 * parse as a URL, or there is no scheme before the '@', the whole URL is replaced by asterisks and
 * only the reason is logged: neither the URL nor any part of it is ever logged.
 */
export const redactUrl = (url: string): string => {
  const redacted = withoutCredentials(url);
  const failure  = redacted === null ? 'no scheme before the credentials' : parseFailure(redacted);

  if (redacted !== null && failure === null) return redacted;

  logger.warn({ reason: failure }, 'URL does not parse, redacting it in full');

  return REDACTED;
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
