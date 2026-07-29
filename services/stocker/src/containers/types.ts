/**
 * A container is a way of wrapping bytes on disk — zip, gzip, tar.gz. Adding one
 * is adding a file here and an entry in the registry; nothing else in stocker
 * knows what containers exist.
 */
export interface Unpacked {
  /** Paths a query engine can read. Several when a container holds several files. */
  paths:   string[];

  /** Removes anything extracted. Always safe to call, even when nothing was. */
  dispose: () => Promise<void>;
}

export interface Container {
  /**
   * Whether the engine can read this container directly. When true, `unpack`
   * is never called and the raw file is handed over untouched — which is the
   * difference between copying a 23 GB month to a temp directory and not.
   */
  native:  boolean;

  unpack(absolute: string, into: string): Promise<string[]>;
}
