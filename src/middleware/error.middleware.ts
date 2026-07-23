import { NextFunction, Request, Response } from 'express';
import { ApiError } from '../utils/asyncHandler';

export function notFoundHandler(req: Request, res: Response) {
  res.status(404).json({ error: `Route not found: ${req.method} ${req.originalUrl}` });
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function errorHandler(err: unknown, req: Request, res: Response, next: NextFunction) {
  if (err instanceof ApiError) {
    return res.status(err.status).json({ error: err.message });
  }
  console.error(err);
  const message = err instanceof Error ? err.message : 'Internal server error';
  res.status(500).json({ error: message });
}
