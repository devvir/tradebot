/**
 * A container is a way of wrapping bytes on disk — zip, gzip, tar.gz. Adding one
 * is adding a file here and an entry in the registry; nothing else in stocker
 * knows what containers exist.
 */
export interface Container {
  /**
   * Whether the engine can read this container directly. When true, `unpack`
   * is never called and the raw file is handed over untouched — which is the
   * difference between copying a 23 GB month to a temp directory and not.
   */
  native:  boolean;

  /**
   * Extract into `into`, a directory other archives are extracted into as well:
   * `tag` is this archive's alone, and goes in front of every name it writes so
   * that two archives holding a member of the same name do not meet.
   */
  unpack(absolute: string, into: string, tag: string): Promise<string[]>;

  /**
   * The archive's members as they stand in memory, where it is small enough to
   * be read whole; null where it is not, and it is taken the ordinary way.
   */
  members?(absolute: string): Member[] | null;
}

/** One file inside an archive, read into memory. */
export interface Member {
  name: string;
  data: Buffer;
}

/** An archive on disk, and how it is wrapped. */
export interface Wrapped {
  absolute:  string;
  container: string;

  /** Which of the shapes asked for its small members may be gathered under — see `Packer`; none where it has none. */
  shape?:    number;
}

/** One file that small members of the same shape are gathered into. */
export interface Pack {
  /** Whether every member opens with a line of column names, kept once. */
  header: boolean;
}

/**
 * What extracting a list of archives came to: each one's paths at its place,
 * the file gathered for each shape asked for — null where nothing went into
 * it — and the bytes written.
 */
export interface Extracted {
  paths: string[][];
  packs: (string | null)[];
  bytes: number;
}

/** What a worker thread is asked, and what it answers. */
export interface ExtractAsked {
  id:     number;
  inputs: readonly Wrapped[];
  dir:    string;
  shapes: readonly Pack[];
}

export type ExtractAnswered =
  | ({ id: number } & Extracted)
  | { id: number; error: string };

/** One thread of the pool, and whoever is waiting on what it is doing. */
export interface PoolWorker {
  thread: import('node:worker_threads').Worker;
  settle: { resolve: (done: Extracted) => void; reject: (err: Error) => void } | null;
}

/** Several archives extracted together, each one's paths at its place in the list. */
export interface UnpackedAll {
  paths:   string[][];

  /** The file small members were gathered into, for each shape asked for; null where none were. */
  packs:   (string | null)[];

  /** What was written to scratch for them; zero where nothing had to be extracted. */
  bytes:   number;

  /** Removes everything extracted, at once. Always safe to call. */
  dispose: () => Promise<void>;
}
