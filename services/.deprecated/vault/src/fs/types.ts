export type FileState   = 'open' | 'closed' | 'none';
export type FileListing = Record<string, Exclude<FileState, 'none'>>;

/**
 * A closed file opened for reading: a decompressed byte stream plus a `close`
 * the caller MUST invoke once finished to release the underlying file handle.
 */
export interface OpenedFile {
  stream: NodeJS.ReadableStream;
  close:  () => Promise<void>;
}
