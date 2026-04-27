// Express error-handling middleware.
//
// Responsible for: catching aborted client connections, malformed JSON from
// body-parser, and any unhandled errors that bubble up from route handlers.
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

    // Clients (journalist) occasionally drop connections mid-request when they
    // time out and retry. Express surfaces this as a BadRequestError with
    // type 'request.aborted' — not a server error.
    if (e.type === 'request.aborted') {
      if (! res.headersSent) res.status(499).end();
      return;
    }

    // body-parser rejects non-object/array JSON (strict mode) with a 400 SyntaxError.
    if (e.status === 400 && err instanceof SyntaxError) {
      if (! res.headersSent) res.status(400).json({ error: 'Invalid JSON body' });
      return;
    }
  }

  logger.error({ err }, 'Unhandled request error');
  if (! res.headersSent) res.status(500).json({ error: 'Internal server error' });
};
