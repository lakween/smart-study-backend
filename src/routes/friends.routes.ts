import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { requireAuth } from '../middleware/auth.middleware';
import { asyncHandler, ApiError } from '../utils/asyncHandler';
import { toFriendDto } from '../utils/serializers';
import { createNotification } from '../services/notification.service';

const router = Router();

/** Visibility gate shared by subjects/topics/documents/quizzes when viewed by someone other than the owner. */
export function visibleToViewer(visibility: string, ownerId: string, viewerId: string, isFriend: boolean): boolean {
  if (ownerId === viewerId) return true;
  if (visibility === 'PUBLIC') return true;
  if (visibility === 'FRIENDS_ONLY') return isFriend;
  return false;
}

export async function friendshipStatusBetween(
  viewerId: string,
  otherId: string
): Promise<'friends' | 'pending' | 'sent' | 'none'> {
  if (viewerId === otherId) return 'friends';
  const friendship = await prisma.friendship.findFirst({
    where: {
      OR: [
        { requesterId: viewerId, addresseeId: otherId },
        { requesterId: otherId, addresseeId: viewerId },
      ],
    },
  });
  if (!friendship) return 'none';
  if (friendship.status === 'ACCEPTED') return 'friends';
  if (friendship.status === 'DECLINED') return 'none';
  return friendship.requesterId === viewerId ? 'sent' : 'pending';
}

async function acceptedFriendIds(userId: string): Promise<string[]> {
  const rows = await prisma.friendship.findMany({
    where: { status: 'ACCEPTED', OR: [{ requesterId: userId }, { addresseeId: userId }] },
  });
  return rows.map((f) => (f.requesterId === userId ? f.addresseeId : f.requesterId));
}

async function mutualFriendsCount(userId: string, otherId: string): Promise<number> {
  const [mine, theirs] = await Promise.all([acceptedFriendIds(userId), acceptedFriendIds(otherId)]);
  const theirSet = new Set(theirs);
  return mine.filter((id) => theirSet.has(id)).length;
}

router.use(requireAuth);

// GET /friends - accepted friends list
router.get(
  '/',
  asyncHandler(async (req, res) => {
    const userId = req.userId!;
    const friendIds = await acceptedFriendIds(userId);
    const users = await prisma.user.findMany({ where: { id: { in: friendIds } } });
    const dtos = await Promise.all(
      users.map(async (u) => toFriendDto(u, 'friends', await mutualFriendsCount(userId, u.id)))
    );
    res.json({ friends: dtos });
  })
);

// GET /friends/search?q=name-or-email&page=1&limit=20
router.get(
  '/search',
  asyncHandler(async (req, res) => {
    const userId = req.userId!;
    const q = String(req.query.q ?? '').trim();
    const page = Math.max(1, Number.parseInt(String(req.query.page ?? '1'), 10) || 1);
    const limit = Math.min(50, Math.max(1, Number.parseInt(String(req.query.limit ?? '20'), 10) || 20));
    const where = {
      id: { not: userId },
      ...(q
        ? { OR: [{ fullName: { contains: q, mode: 'insensitive' as const } }, { email: { contains: q, mode: 'insensitive' as const } }] }
        : {}),
    };
    const [results, total] = await Promise.all([
      prisma.user.findMany({
        where,
        orderBy: [{ fullName: 'asc' }, { id: 'asc' }],
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.user.count({ where }),
    ]);
    const dtos = await Promise.all(
      results.map(async (u) =>
        toFriendDto(u, await friendshipStatusBetween(userId, u.id), await mutualFriendsCount(userId, u.id))
      )
    );
    res.json({ users: dtos, page, limit, total, hasMore: page * limit < total });
  })
);

// GET /friends/requests - received + sent pending requests
router.get(
  '/requests',
  asyncHandler(async (req, res) => {
    const userId = req.userId!;
    const [received, sent] = await Promise.all([
      prisma.friendship.findMany({ where: { addresseeId: userId, status: 'PENDING' }, include: { requester: true } }),
      prisma.friendship.findMany({ where: { requesterId: userId, status: 'PENDING' }, include: { addressee: true } }),
    ]);
    const receivedDtos = await Promise.all(
      received.map(async (f) => ({
        ...toFriendDto(f.requester, 'pending', await mutualFriendsCount(userId, f.requesterId)),
        requestId: f.id,
      }))
    );
    const sentDtos = await Promise.all(
      sent.map(async (f) => ({
        ...toFriendDto(f.addressee, 'sent', await mutualFriendsCount(userId, f.addresseeId)),
        requestId: f.id,
      }))
    );
    res.json({ received: receivedDtos, sent: sentDtos });
  })
);

const targetSchema = z.object({ userId: z.string().uuid() });

// POST /friends/request/:userId
router.post(
  '/request/:userId',
  asyncHandler(async (req, res) => {
    const requesterId = req.userId!;
    const { userId: addresseeId } = targetSchema.parse({ userId: req.params.userId });
    if (requesterId === addresseeId) throw new ApiError(400, 'Cannot friend yourself');

    const existing = await prisma.friendship.findFirst({
      where: {
        OR: [
          { requesterId, addresseeId },
          { requesterId: addresseeId, addresseeId: requesterId },
        ],
      },
    });
    if (existing) throw new ApiError(409, 'A friend request already exists between these users');

    await prisma.friendship.create({ data: { requesterId, addresseeId, status: 'PENDING' } });
    const requester = await prisma.user.findUniqueOrThrow({ where: { id: requesterId } });
    await createNotification({
      userId: addresseeId,
      title: `Friend Request from ${requester.fullName}`,
      message: `${requester.fullName} wants to connect with you.`,
      type: 'FRIEND',
      relatedId: requesterId,
    });
    res.status(201).json({ success: true });
  })
);

// POST /friends/accept/:userId - userId is the original requester
router.post(
  '/accept/:userId',
  asyncHandler(async (req, res) => {
    const addresseeId = req.userId!;
    const { userId: requesterId } = targetSchema.parse({ userId: req.params.userId });
    const friendship = await prisma.friendship.findFirst({ where: { requesterId, addresseeId, status: 'PENDING' } });
    if (!friendship) throw new ApiError(404, 'Friend request not found');
    await prisma.friendship.update({ where: { id: friendship.id }, data: { status: 'ACCEPTED' } });
    const addressee = await prisma.user.findUniqueOrThrow({ where: { id: addresseeId } });
    await createNotification({
      userId: requesterId,
      title: `${addressee.fullName} accepted your request`,
      message: `You and ${addressee.fullName} are now friends.`,
      type: 'FRIEND',
      relatedId: addresseeId,
    });
    res.json({ success: true });
  })
);

// POST /friends/decline/:userId
router.post(
  '/decline/:userId',
  asyncHandler(async (req, res) => {
    const addresseeId = req.userId!;
    const { userId: requesterId } = targetSchema.parse({ userId: req.params.userId });
    const friendship = await prisma.friendship.findFirst({ where: { requesterId, addresseeId, status: 'PENDING' } });
    if (!friendship) throw new ApiError(404, 'Friend request not found');
    await prisma.friendship.delete({ where: { id: friendship.id } });
    res.json({ success: true });
  })
);

// DELETE /friends/request/:userId - cancel a request I sent
router.delete(
  '/request/:userId',
  asyncHandler(async (req, res) => {
    const requesterId = req.userId!;
    const { userId: addresseeId } = targetSchema.parse({ userId: req.params.userId });
    const friendship = await prisma.friendship.findFirst({ where: { requesterId, addresseeId, status: 'PENDING' } });
    if (!friendship) throw new ApiError(404, 'Friend request not found');
    await prisma.friendship.delete({ where: { id: friendship.id } });
    res.json({ success: true });
  })
);

// DELETE /friends/:userId - remove an existing friend
router.delete(
  '/:userId',
  asyncHandler(async (req, res) => {
    const userId = req.userId!;
    const { userId: otherId } = targetSchema.parse({ userId: req.params.userId });
    const friendship = await prisma.friendship.findFirst({
      where: {
        status: 'ACCEPTED',
        OR: [
          { requesterId: userId, addresseeId: otherId },
          { requesterId: otherId, addresseeId: userId },
        ],
      },
    });
    if (!friendship) throw new ApiError(404, 'Friendship not found');
    await prisma.friendship.delete({ where: { id: friendship.id } });
    res.json({ success: true });
  })
);

export default router;
