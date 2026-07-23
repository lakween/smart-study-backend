import { Router } from 'express';
import { prisma } from '../lib/prisma';
import { requireAuth } from '../middleware/auth.middleware';
import { asyncHandler } from '../utils/asyncHandler';
import { toNotificationDto } from '../utils/serializers';

const router = Router();
router.use(requireAuth);

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const notifications = await prisma.notification.findMany({
      where: { userId: req.userId },
      orderBy: { createdAt: 'desc' },
    });
    res.json({ notifications: notifications.map(toNotificationDto) });
  })
);

router.post(
  '/read-all',
  asyncHandler(async (req, res) => {
    await prisma.notification.updateMany({ where: { userId: req.userId, isRead: false }, data: { isRead: true } });
    res.json({ success: true });
  })
);

router.post(
  '/:id/read',
  asyncHandler(async (req, res) => {
    await prisma.notification.updateMany({ where: { id: req.params.id, userId: req.userId }, data: { isRead: true } });
    res.json({ success: true });
  })
);

router.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    await prisma.notification.deleteMany({ where: { id: req.params.id, userId: req.userId } });
    res.json({ success: true });
  })
);

export default router;
