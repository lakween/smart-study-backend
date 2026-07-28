import type { Server as HttpServer } from 'http';
import { Server } from 'socket.io';

import { env } from '../config/env';
import { prisma } from '../lib/prisma';
import { verifyToken } from '../utils/jwt';

let io: Server | null = null;

export function initializeSocket(httpServer: HttpServer): Server {
  io = new Server(httpServer, {
    cors: {
      origin: env.corsOrigin === '*' ? true : env.corsOrigin.split(','),
    },
  });

  io.use(async (socket, next) => {
    const token = socket.handshake.auth?.token;
    if (typeof token !== 'string' || token.length === 0) {
      next(new Error('Authentication required'));
      return;
    }

    let userId: string;
    try {
      userId = verifyToken(token).userId;
    } catch {
      next(new Error('Invalid or expired token'));
      return;
    }

    try {
      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { id: true },
      });
      if (!user) {
        next(new Error('Session user no longer exists'));
        return;
      }
      socket.data.userId = user.id;
      next();
    } catch {
      next(new Error('Could not validate socket session'));
    }
  });

  io.on('connection', (socket) => {
    const userId = socket.data.userId as string;
    socket.join(userRoom(userId));
  });

  return io;
}

export function emitNotification(userId: string, notification: unknown): void {
  io?.to(userRoom(userId)).emit('notification:new', notification);
}

function userRoom(userId: string): string {
  return `user:${userId}`;
}
