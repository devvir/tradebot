import type { RequestHandler } from 'express';
import { z, type ZodTypeAny } from 'zod';

export const validateBody = (schema: ZodTypeAny): RequestHandler => (req, res, next) => {
  const result = schema.safeParse(req.body);

  if (! result.success) return next(result.error);

  res.locals['body'] = result.data;

  next();
};

export const RegisterSymbolSchema = z.object({
  symbol: z.string().min(1),
});

export const RegisterCurrencySchema = z.object({
  currency: z.string().min(1),
});
