// Answer to the service health check.
//
// The health check reports storage health: 200 `{ status: 'ok' }` while
// storage is healthy, 503 `{ status: 'unhealthy', reason }` while it is not.

import type { ServerResponse } from 'http';
import { isHealthy, getFailureReason } from '../fs/health';

export const answerHealthCheck = (res: ServerResponse): void => {
  const healthy = isHealthy();
  const body    = healthy ? { status: 'ok' } : { status: 'unhealthy', reason: getFailureReason() };

  res.writeHead(healthy ? 200 : 503, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
};
