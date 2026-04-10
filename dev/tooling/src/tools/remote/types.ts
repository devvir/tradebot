export interface RemoteDest {
  userHost: string;
  path: string;
}

export function parseRemoteDest(dest: string): RemoteDest | null {
  const colonIdx = dest.indexOf(':');

  if (colonIdx === -1 || ! dest.includes('@')) {
    return null;
  }

  return {
    userHost: dest.slice(0, colonIdx),
    path: dest.slice(colonIdx + 1).replace(/\/$/, ''),
  };
}
