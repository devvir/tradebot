/**
 * Everything catalog-ui is configured by. It holds no domain types of its own:
 * what the catalog returns is passed through untouched, so a field added there
 * appears here without this service being taught about it.
 */

export interface Config {
  /** Where the catalog answers. */
  catalogUrl:   string;

  /**
   * The catalog's secret, held **here** rather than in the browser.
   *
   * Blank where the catalog is open. Either way the page never sees it: the
   * browser talks to this service, and this service talks to the catalog.
   */
  catalogToken: string;

  /** Where hauler answers, for the shopping list. Blank where there is none to reach. */
  haulerUrl:    string;

  /** Where this service listens inside the container. */
  port:         number;

  /** What service-kit's factory expects of any config it is handed. */
  [key: string]: unknown;
}
