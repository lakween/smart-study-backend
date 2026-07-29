import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { requireAuth } from '../middleware/auth.middleware';
import { asyncHandler, ApiError } from '../utils/asyncHandler';
import { visibilityToDb } from '../utils/mappers';
import { toTopicDto } from '../utils/serializers';
import { visibleToViewer, friendshipStatusBetween } from './friends.routes';
import { topicCopyCounts } from '../utils/copyStats';

const router = Router();
router.use(requireAuth);

async function topicRevisionInfo(topicId: string, userId: string) {
  const rows = await prisma.spacedRepetition.findMany({
    where: { topicId, userId },
    orderBy: { nextRevisionDate: 'asc' },
  });
  if (rows.length === 0) return { lastScore: null, nextRevisionDate: null };
  return { lastScore: rows[0].lastScore, nextRevisionDate: rows[0].nextRevisionDate };
}

async function assertSubjectAccess(subjectId: string, viewerId: string) {
  const subject = await prisma.subject.findUnique({ where: { id: subjectId } });
  if (!subject) throw new ApiError(404, 'Subject not found');
  const isFriend = (await friendshipStatusBetween(viewerId, subject.ownerId)) === 'friends';
  if (!visibleToViewer(subject.visibility, subject.ownerId, viewerId, isFriend)) {
    throw new ApiError(403, 'You do not have access to this subject');
  }
  return subject;
}

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const viewerId = req.userId!;
    const subjectId = req.query.subjectId as string | undefined;
    if (!subjectId) throw new ApiError(400, 'subjectId query parameter is required');
    await assertSubjectAccess(subjectId, viewerId);

    const topics = await prisma.topic.findMany({
      where: { subjectId },
      include: { _count: { select: { quizzes: true } } },
      orderBy: { createdAt: 'asc' },
    });
    const subject = await prisma.subject.findUniqueOrThrow({ where: { id: subjectId } });
    const isFriend = (await friendshipStatusBetween(viewerId, subject.ownerId)) === 'friends';
    const visibleTopics = topics.filter((topic) =>
      visibleToViewer(topic.visibility, subject.ownerId, viewerId, isFriend),
    );
    const copiedBy = await topicCopyCounts(visibleTopics.map((topic) => topic.id));
    const dtos = await Promise.all(
      visibleTopics.map(async (t) => toTopicDto(t, {
        ...await topicRevisionInfo(t.id, viewerId),
        copiedByCount: copiedBy.get(t.id) ?? 0,
      }))
    );
    res.json({ topics: dtos });
  })
);

router.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const viewerId = req.userId!;
    const topic = await prisma.topic.findUnique({
      where: { id: req.params.id },
      include: { _count: { select: { quizzes: true } } },
    });
    if (!topic) throw new ApiError(404, 'Topic not found');
    await assertSubjectAccess(topic.subjectId, viewerId);
    const copiedBy = await topicCopyCounts([topic.id]);
    res.json({ topic: toTopicDto(topic, {
      ...await topicRevisionInfo(topic.id, viewerId),
      copiedByCount: copiedBy.get(topic.id) ?? 0,
    }) });
  })
);

const cleanText = (value: string) => value.replace(/\0/g, '').trim();

function visibilityLevel(value: string): number {
  if (value === 'PUBLIC' || value === 'public') return 2;
  if (value === 'FRIENDS_ONLY' || value === 'friendsOnly') return 1;
  return 0;
}

const createSchema = z.object({
  subjectId: z.string().uuid(),
  name: z.string().transform(cleanText).pipe(z.string().min(2).max(100)),
  description: z.string().transform(cleanText).nullable().optional(),
  visibility: z.enum(['private', 'friendsOnly', 'public']).default('private'),
  allowCopy: z.boolean().default(false),
  isArchived: z.boolean().default(false),
});

router.post(
  '/',
  asyncHandler(async (req, res) => {
    const body = createSchema.parse(req.body);
    const subject = await prisma.subject.findUnique({ where: { id: body.subjectId } });
    if (!subject) throw new ApiError(404, 'Subject not found');
    if (subject.ownerId !== req.userId) throw new ApiError(403, 'Only the subject owner can add topics');
    if (visibilityLevel(body.visibility) > visibilityLevel(subject.visibility)) {
      throw new ApiError(400, 'Topic visibility cannot be broader than its subject visibility');
    }

    const topic = await prisma.topic.create({
      data: {
        subjectId: body.subjectId,
        name: body.name,
        description: body.description || null,
        visibility: visibilityToDb(body.visibility),
        allowCopy: body.allowCopy,
        isArchived: body.isArchived,
      },
      include: { _count: { select: { quizzes: true } } },
    });
    res.status(201).json({ topic: toTopicDto(topic) });
  })
);

const updateSchema = createSchema.omit({ subjectId: true }).partial();

router.patch(
  '/:id',
  asyncHandler(async (req, res) => {
    const topic = await prisma.topic.findUnique({ where: { id: req.params.id }, include: { subject: true } });
    if (!topic) throw new ApiError(404, 'Topic not found');
    if (topic.subject.ownerId !== req.userId) throw new ApiError(403, 'Only the subject owner can edit this topic');

    const body = updateSchema.parse(req.body);
    if (body.visibility && visibilityLevel(body.visibility) > visibilityLevel(topic.subject.visibility)) {
      throw new ApiError(400, 'Topic visibility cannot be broader than its subject visibility');
    }
    const updated = await prisma.topic.update({
      where: { id: req.params.id },
      data: {
        name: body.name,
        description: body.description,
        visibility: body.visibility ? visibilityToDb(body.visibility) : undefined,
        allowCopy: body.allowCopy,
        isArchived: body.isArchived,
      },
      include: { _count: { select: { quizzes: true } } },
    });
    res.json({ topic: toTopicDto(updated, await topicRevisionInfo(updated.id, req.userId!)) });
  })
);

router.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const topic = await prisma.topic.findUnique({ where: { id: req.params.id }, include: { subject: true } });
    if (!topic) throw new ApiError(404, 'Topic not found');
    if (topic.subject.ownerId !== req.userId) throw new ApiError(403, 'Only the subject owner can delete this topic');
    await prisma.topic.delete({ where: { id: req.params.id } });
    res.json({ success: true });
  })
);

const copyTopicSchema = z.object({ targetSubjectId: z.string().uuid() });

router.post(
  '/:id/copy',
  asyncHandler(async (req, res) => {
    const viewerId = req.userId!;
    const { targetSubjectId } = copyTopicSchema.parse(req.body);
    const source = await prisma.topic.findUnique({
      where: { id: req.params.id },
      include: { subject: { include: { owner: true } } },
    });
    if (!source) throw new ApiError(404, 'Topic not found');
    const isFriend = (await friendshipStatusBetween(viewerId, source.subject.ownerId)) === 'friends';
    if (!visibleToViewer(source.visibility, source.subject.ownerId, viewerId, isFriend)) {
      throw new ApiError(403, 'You do not have access to this topic');
    }
    if (source.subject.ownerId !== viewerId && !source.allowCopy) {
      throw new ApiError(403, 'The owner has not allowed copying this topic');
    }
    const target = await prisma.subject.findUnique({ where: { id: targetSubjectId } });
    if (!target || target.ownerId !== viewerId || target.isArchived) {
      throw new ApiError(400, 'Choose one of your active subjects');
    }
    const copy = await prisma.topic.create({
      data: {
        subjectId: target.id,
        name: `${source.name} (Copy)`,
        description: source.description,
        visibility: 'PRIVATE',
        allowCopy: false,
        originalCreatorId: source.originalCreatorId ?? source.subject.ownerId,
        originalCreatorName: source.originalCreatorName ?? source.subject.owner.fullName,
        copiedFromId: source.id,
      },
      include: { _count: { select: { quizzes: true } } },
    });
    res.status(201).json({ topic: toTopicDto(copy) });
  }),
);

export default router;
