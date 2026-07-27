import type { NotificationType } from '@prisma/client';

import { prisma } from '../lib/prisma';
import { emitNotification } from '../realtime/socket';
import { toNotificationDto } from '../utils/serializers';

interface CreateNotificationInput {
  userId: string;
  title: string;
  message: string;
  type: NotificationType;
  relatedId?: string | null;
}

export async function createNotification(input: CreateNotificationInput) {
  const notification = await prisma.notification.create({ data: input });
  emitNotification(input.userId, toNotificationDto(notification));
  return notification;
}

