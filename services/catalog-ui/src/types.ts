/**
 * Everything catalog-ui is configured by. It holds no domain types of its own:
 * what the catalog returns is passed through untouched, so a field added there
 * appears here without this service being taught about it.
 */

export interface Config {
  /** Where the catalog answers: contents, listings and lenses. */
  catalogApi:    string;

  /** Where prospector's collector answers: surveys and their status. */
  prospectorApi: string;

  /**
   * The catalog's secret, held **here** rather than in the browser.
   *
   * Blank where the catalog is open. Either way the page never sees it: the
   * browser talks to this service, and this service talks to the catalog and
   * to prospector, which check the same one.
   */
  catalogToken:  string;

  /**
   * The `Host` names (or `host:port`) this service answers API requests for,
   * from `CATALOG_UI_HOSTS`. Empty means any: a name a browser was pointed at
   * by DNS rebinding is then served like any other.
   */
  allowedHosts:  string[];

  /** How long a forwarded request waits for the service behind it. */
  upstreamTimeoutMs: number;

  /** Where this service listens inside the container. */
  port:         number;

  /** What service-kit's factory expects of any config it is handed. */
  [key: string]: unknown;
}
