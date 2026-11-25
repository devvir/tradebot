// Express error-handling middleware.
//
// Responsible for: catching aborted client connections, malformed JSON and
// other client errors from body-parser, and any unhandled errors that bubble
// up from route handlers.
// Keeps error-handling noise out of routes.ts and index.ts.

import type { NextFunction, Request, Response } from 'express';
import { logger } from '@devvir/service-kit';

export const errorMiddleware = (
  err:  unknown,
  _req: Request,
  res:  Response,
  _next: NextFunction,
): void => {
  if (err && typeof err === 'object') {
    const e = err as { type?: string; status?: number };

    // A client that drops the connection mid-request surfaces as an error of
    // type 'request.aborted': answered 499, not counted as a server error.
    if (e.type === 'request.aborted') {
      if (! res.headersSent) res.status(499).end();
      return;
    }

    // body-parser rejects non-object/array JSON (strict mode) with a 400 SyntaxError.
    if (e.status === 400 && err instanceof SyntaxError) {
      if (! res.headersSent) res.status(400).json({ error: 'Invalid JSON body' });
      return;
    }

    // Other client errors raised with a status meant to be shown, such as
    // body-parser's 413 (body over the size limit) and 415 (unsupported
    // charset or encoding), keep their status and message.
    if (
      typeof e.status === 'number' && e.status >= 400 && e.status < 500 &&
      (err as { expose?: unknown }).expose === true
    ) {
      if (! res.headersSent) res.status(e.status).json({ error: (err as Error).message });
      return;
    }
  }

  logger.error({ err }, 'Unhandled request error');

  // A response already under way cannot carry an error status any more; it is
  // cut, so the client sees it fail rather than wait on it forever.
  if (res.headersSent) {
    res.destroy();
    return;
  }

  res.status(500).json({ error: 'Internal server error' });
};
