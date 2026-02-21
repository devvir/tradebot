/**
 * Replace credentials in a URL with asterisks for safe logging.
 */
export const redactedUrl = (url: string): string => {
  try {
    const urlObj = new URL(url);

    if (urlObj.username || urlObj.password) {
      urlObj.username = '*****';
      urlObj.password = '*****';
    }

    return urlObj.toString();
  } catch {
    return '*****';
  }
};
