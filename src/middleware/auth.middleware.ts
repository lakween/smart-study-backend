import { NextFunction, Request, Response } from 'express';
import { verifyToken } from '../utils/jwt';
import { ApiError } from '../utils/asyncHandler';
import { prisma } from '../lib/prisma';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      userId?: string;
    }
  }
}

export async function requireAuth(req: Request, _res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return next(new ApiError(401, 'Missing or invalid Authorization header'));
  }
  const token = header.slice('Bearer '.length);
  let userId: string;
  try {
    userId = verifyToken(token).userId;
  } catch {
    return next(new ApiError(401, 'Invalid or expired token'));
  }

  try {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true },
    });
    if (!user) {
      return next(new ApiError(401, 'Session user no longer exists'));
    }
    req.userId = user.id;
    next();
  } catch (error) {
    next(error);
  }
}
