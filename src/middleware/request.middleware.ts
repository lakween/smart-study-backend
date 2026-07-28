import { NextFunction, Request, Response } from 'express';
import { randomUUID } from 'crypto';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      requestId: string;
    }
  }
}

export function requestContext(req: Request, res: Response, next: NextFunction) {
  const suppliedId = req.header('x-request-id')?.trim();
  req.requestId = suppliedId && suppliedId.length <= 100 ? suppliedId : randomUUID();
  res.setHeader('x-request-id', req.requestId);

  const startedAt = process.hrtime.bigint();
  res.on('finish', () => {
    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
    console.info(
      JSON.stringify({
        level: 'info',
        event: 'http_request',
        requestId: req.requestId,
        method: req.method,
        path: req.originalUrl,
        status: res.statusCode,
        durationMs: Math.round(durationMs),
      }),
    );
  });

  next();
}

