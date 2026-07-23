import { NextFunction, Request, Response } from 'express';
import { verifyToken } from '../utils/jwt';
import { ApiError } from '../utils/asyncHandler';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      userId?: string;
    }
  }
}

export function requireAuth(req: Request, _res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return next(new ApiError(401, 'Missing or invalid Authorization header'));
  }
  const token = header.slice('Bearer '.length);
  try {
    const payload = verifyToken(token);
    req.userId = payload.userId;
    next();
  } catch {
    next(new ApiError(401, 'Invalid or expired token'));
  }
}
