import { NextFunction, Request, Response } from 'express';
import { Prisma } from '@prisma/client';
import multer from 'multer';
import { ZodError } from 'zod';
import { ApiError } from '../utils/asyncHandler';

type PublicError = {
  status: number;
  body: {
    error: string;
    details?: Array<{ path: string; message: string }>;
  };
};

export function publicErrorFor(err: unknown): PublicError {
  if (err instanceof ApiError) {
    return { status: err.status, body: { error: err.message } };
  }

  if (err instanceof ZodError) {
    return {
      status: 400,
      body: {
        error: 'Invalid request data',
        details: err.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      },
    };
  }

  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    switch (err.code) {
      case 'P2002':
        return { status: 409, body: { error: 'A record with this value already exists' } };
      case 'P2003':
        return { status: 409, body: { error: 'A related record does not exist or is still in use' } };
      case 'P2025':
        return { status: 404, body: { error: 'Record not found' } };
      default:
        return { status: 500, body: { error: 'Internal server error' } };
    }
  }

  if (err instanceof multer.MulterError) {
    const message = err.code === 'LIMIT_FILE_SIZE'
      ? 'File is too large. Maximum size is 10 MB.'
      : 'The uploaded file could not be processed.';
    return { status: 400, body: { error: message } };
  }

  if (err instanceof SyntaxError && 'body' in err) {
    return { status: 400, body: { error: 'Request body contains invalid JSON' } };
  }

  return { status: 500, body: { error: 'Internal server error' } };
}

export function notFoundHandler(req: Request, res: Response) {
  res.status(404).json({ error: `Route not found: ${req.method} ${req.originalUrl}` });
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function errorHandler(err: unknown, req: Request, res: Response, next: NextFunction) {
  const publicError = publicErrorFor(err);
  if (publicError.status >= 500) {
    console.error(
      JSON.stringify({
        level: 'error',
        event: 'request_failed',
        requestId: req.requestId,
        method: req.method,
        path: req.originalUrl,
        error: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
      }),
    );
  }
  res.status(publicError.status).json({
    ...publicError.body,
    ...(publicError.status >= 500 && req.requestId ? { requestId: req.requestId } : {}),
  });
}
