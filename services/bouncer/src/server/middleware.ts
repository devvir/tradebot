import type { RequestHandler } from 'express';
import { z, type ZodTypeAny } from 'zod';

export const requireAuth = (token: string): RequestHandler => (req, res, next): void => {
  if (req.headers['authorization'] !== `Bearer ${token}`) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  next();
};

export const validateBody = (schema: ZodTypeAny): RequestHandler => (req, res, next) => {
  const result = schema.safeParse(req.body);

  if (! result.success) return next(result.error);

  res.locals['body'] = result.data;

  next();
};

export const validateQuery = (schema: ZodTypeAny): RequestHandler => (req, res, next) => {
  const result = schema.safeParse(req.query);

  if (! result.success) return next(result.error);

  res.locals['query'] = result.data;

  next();
};

export const CreateAccountSchema = z.object({
  id:        z.string().min(1),
  type:      z.enum(['live', 'testnet', 'replay']),
  wsUrl:     z.string().url(),
  restUrl:   z.string().url(),
  apiKey:    z.string().min(1),
  apiSecret: z.string().min(1),
});

export const AccountByIdQuerySchema = z.object({
  expires: z.coerce.number().int().positive().optional(),
});

export const SignWsSchema = z.object({
  accountId: z.string().min(1),
  expires:   z.number().int().positive(),
});

export const SignRestSchema = z.object({
  accountId: z.string().min(1),
  verb:      z.string().min(1),
  path:      z.string().min(1),
  expires:   z.number().int().positive(),
  body:      z.string().default(''),
});
