import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

/** `execFile`, awaited: the command's stdout and stderr, or an error carrying them. */
export const execFileAsync = promisify(execFile);
