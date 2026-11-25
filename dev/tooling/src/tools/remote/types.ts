import path from 'node:path';

export interface RemoteDest {
  /** `user@host` as ssh and scp take it, brackets included for an IPv6 host. */
  userHost: string;
  /**
   * The remote base directory, normalised (no `.` or `..` segments, no trailing slashes): absolute,
   * or relative to the login home (a leading `~/` is dropped, since ssh and scp both resolve
   * relative paths against the home).
   */
  path: string;
}

const FORMAT = 'expected user@host:/remote/path';

/**
 * Parse `user@host:/remote/path`, or `user@[ipv6]:/remote/path`. Throws, with the reason, on
 * anything ssh could read as an option or split into several words, and on a path that resolves
 * to the filesystem root or that names no directory.
 */
export function parseRemoteDest(raw: string): RemoteDest {
  const dest = raw.trim();
  const at = dest.indexOf('@');

  if (at <= 0) {
    throw new Error(`Invalid destination "${raw}": ${FORMAT}`);
  }

  let sep: number;

  if (dest[at + 1] === '[') {
    const close = dest.indexOf(']', at + 2);

    if (close === -1 || dest[close + 1] !== ':') {
      throw new Error(`Invalid destination "${raw}": ${FORMAT} (an IPv6 host goes in brackets)`);
    }

    sep = close + 1;
  } else {
    sep = dest.indexOf(':', at + 1);
  }

  if (sep === -1 || sep === at + 1) {
    throw new Error(`Invalid destination "${raw}": ${FORMAT}`);
  }

  const userHost = dest.slice(0, sep);

  if (userHost.startsWith('-') || /\s/.test(userHost)) {
    throw new Error(`Invalid destination "${raw}": user@host must not start with "-" or contain whitespace`);
  }

  let remotePath = dest.slice(sep + 1).replace(/\/+$/, '');

  if (remotePath.startsWith('~/')) {
    remotePath = remotePath.slice(2).replace(/^\/+/, '');
  } else if (remotePath.startsWith('~')) {
    throw new Error(`Invalid destination "${raw}": name a directory under the home as ~/dir, or give an absolute path`);
  }

  if (remotePath !== '') remotePath = path.posix.normalize(remotePath).replace(/\/+$/, '');

  if (remotePath === '') {
    throw new Error(`Invalid destination "${raw}": refusing to sync to the filesystem root, name a remote directory`);
  }

  if (remotePath === '.' || remotePath === '..' || remotePath.startsWith('../')) {
    throw new Error(`Invalid destination "${raw}": the path leaves no directory under the home, name one as ~/dir`);
  }

  return { userHost, path: remotePath };
}
