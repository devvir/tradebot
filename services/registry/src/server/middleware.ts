import type { RequestHandler } from 'express';
import { z, type ZodTypeAny } from 'zod';

/**
 * Validate the request body against `schema`. On failure, forwards an error
 * carrying `status: 400` — the Net express server's error handler renders it
 * as a 400 (it keys off `status`, not the validation library).
 */
export const validateBody = (schema: ZodTypeAny): RequestHandler => (req, res, next) => {
  const result = schema.safeParse(req.body);

  if (! result.success) {
    return next(Object.assign(
      new Error(result.error.issues[0]?.message ?? 'Invalid request'),
      { status: 400 },
    ));
  }

  res.locals['body'] = result.data;

  next();
};

export const RegisterSymbolSchema = z.object({
  symbol: z.string().min(1),
});

export const RegisterCurrencySchema = z.object({
  currency: z.string().min(1),
});
