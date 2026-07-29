import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { requireAuth } from '../middleware/auth.middleware';
import { asyncHandler, ApiError } from '../utils/asyncHandler';
import { toFriendDto } from '../utils/serializers';
import { createNotification } from '../services/notification.service';
import { emitFriendshipChanged } from '../realtime/socket';

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

async function friendshipMetadata(userId: string, rawOtherIds: string[]) {
  const otherIds = [...new Set(rawOtherIds.filter((id) => id !== userId))];
  const empty = new Map<string, { status: 'friends' | 'pending' | 'sent' | 'none'; mutualFriends: number }>();
  if (otherIds.length === 0) return empty;

  const [myFriendIds, relationships, candidateFriendships] = await Promise.all([
    acceptedFriendIds(userId),
    prisma.friendship.findMany({
      where: {
        OR: [
          { requesterId: userId, addresseeId: { in: otherIds } },
          { requesterId: { in: otherIds }, addresseeId: userId },
        ],
      },
    }),
    prisma.friendship.findMany({
      where: {
        status: 'ACCEPTED',
        OR: [{ requesterId: { in: otherIds } }, { addresseeId: { in: otherIds } }],
      },
      select: { requesterId: true, addresseeId: true },
    }),
  ]);

  const relationshipByOther = new Map<string, typeof relationships[number]>();
  for (const relationship of relationships) {
    const otherId = relationship.requesterId === userId
      ? relationship.addresseeId
      : relationship.requesterId;
    relationshipByOther.set(otherId, relationship);
  }
  const candidateSet = new Set(otherIds);
  const candidateFriends = new Map<string, Set<string>>(
    otherIds.map((id) => [id, new Set<string>()]),
  );
  for (const friendship of candidateFriendships) {
    if (candidateSet.has(friendship.requesterId)) {
      candidateFriends.get(friendship.requesterId)!.add(friendship.addresseeId);
    }
    if (candidateSet.has(friendship.addresseeId)) {
      candidateFriends.get(friendship.addresseeId)!.add(friendship.requesterId);
    }
  }

  const myFriendSet = new Set(myFriendIds);
  for (const otherId of otherIds) {
    const relationship = relationshipByOther.get(otherId);
    let status: 'friends' | 'pending' | 'sent' | 'none' = 'none';
    if (relationship?.status === 'ACCEPTED') status = 'friends';
    else if (relationship?.status === 'PENDING') {
      status = relationship.requesterId === userId ? 'sent' : 'pending';
    }
    let mutualFriends = 0;
    for (const friendId of candidateFriends.get(otherId) ?? []) {
      if (myFriendSet.has(friendId)) mutualFriends += 1;
    }
    empty.set(otherId, { status, mutualFriends });
  }
  return empty;
}

async function notifySafely(input: Parameters<typeof createNotification>[0]) {
  try {
    await createNotification(input);
  } catch (error) {
    console.error(JSON.stringify({
      level: 'error',
      event: 'friend_notification_failed',
      userId: input.userId,
      error: error instanceof Error ? error.message : String(error),
    }));
  }
}

router.use(requireAuth);

// GET /friends - accepted friends list
router.get(
  '/',
  asyncHandler(async (req, res) => {
    const userId = req.userId!;
    const friendIds = await acceptedFriendIds(userId);
    const query = z.object({
      q: z.string().trim().max(100).default(''),
      page: z.coerce.number().int().min(1).default(1),
      limit: z.coerce.number().int().min(1).max(50).default(20),
    }).parse(req.query);
    const where = {
      id: { in: friendIds },
      ...(query.q ? {
        OR: [
          { fullName: { contains: query.q, mode: 'insensitive' as const } },
          { email: { contains: query.q, mode: 'insensitive' as const } },
        ],
      } : {}),
    };
    const [users, total] = await prisma.$transaction([
      prisma.user.findMany({
        where,
        orderBy: [{ fullName: 'asc' }, { id: 'asc' }],
        skip: (query.page - 1) * query.limit,
        take: query.limit,
      }),
      prisma.user.count({ where }),
    ]);
    const metadata = await friendshipMetadata(userId, users.map((user) => user.id));
    const dtos = users.map((user) =>
      toFriendDto(user, 'friends', metadata.get(user.id)?.mutualFriends ?? 0),
    );
    res.json({
      friends: dtos,
      page: query.page,
      limit: query.limit,
      total,
      hasMore: query.page * query.limit < total,
    });
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
    const metadata = await friendshipMetadata(userId, results.map((user) => user.id));
    const dtos = results.map((user) => {
      const values = metadata.get(user.id) ?? { status: 'none' as const, mutualFriends: 0 };
      return toFriendDto(user, values.status, values.mutualFriends);
    });
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
    const metadata = await friendshipMetadata(userId, [
      ...received.map((friendship) => friendship.requesterId),
      ...sent.map((friendship) => friendship.addresseeId),
    ]);
    const receivedDtos = received.map((f) => ({
        ...toFriendDto(f.requester, 'pending', metadata.get(f.requesterId)?.mutualFriends ?? 0),
        requestId: f.id,
      }));
    const sentDtos = sent.map((f) => ({
        ...toFriendDto(f.addressee, 'sent', metadata.get(f.addresseeId)?.mutualFriends ?? 0),
        requestId: f.id,
      }));
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
    await notifySafely({
      userId: addresseeId,
      title: `Friend Request from ${requester.fullName}`,
      message: `${requester.fullName} wants to connect with you.`,
      type: 'FRIEND',
      relatedId: requesterId,
    });
    emitFriendshipChanged([requesterId, addresseeId], { action: 'requested', requesterId, addresseeId });
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
    await notifySafely({
      userId: requesterId,
      title: `${addressee.fullName} accepted your request`,
      message: `You and ${addressee.fullName} are now friends.`,
      type: 'FRIEND',
      relatedId: addresseeId,
    });
    emitFriendshipChanged([requesterId, addresseeId], { action: 'accepted', requesterId, addresseeId });
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
    emitFriendshipChanged([requesterId, addresseeId], { action: 'declined', requesterId, addresseeId });
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
    emitFriendshipChanged([requesterId, addresseeId], { action: 'cancelled', requesterId, addresseeId });
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
    emitFriendshipChanged([userId, otherId], { action: 'removed', userId, otherId });
    res.json({ success: true });
  })
);

export default router;
