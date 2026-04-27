export type FileState   = 'open' | 'closed' | 'none';
export type FileListing = Record<string, Exclude<FileState, 'none'>>;
