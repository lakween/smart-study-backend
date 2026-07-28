import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { requireAuth } from '../middleware/auth.middleware';
import { asyncHandler, ApiError } from '../utils/asyncHandler';
import { visibilityToDb } from '../utils/mappers';
import { toTopicDto } from '../utils/serializers';
import { visibleToViewer, friendshipStatusBetween } from './friends.routes';

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
    const dtos = await Promise.all(
      topics.map(async (t) => toTopicDto(t, await topicRevisionInfo(t.id, viewerId)))
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
    res.json({ topic: toTopicDto(topic, await topicRevisionInfo(topic.id, viewerId)) });
  })
);

const cleanText = (value: string) => value.replace(/\0/g, '').trim();

const createSchema = z.object({
  subjectId: z.string().uuid(),
  name: z.string().transform(cleanText).pipe(z.string().min(2).max(100)),
  description: z.string().transform(cleanText).nullable().optional(),
  visibility: z.enum(['private', 'friendsOnly', 'public']).default('private'),
  allowCopy: z.boolean().default(false),
});

router.post(
  '/',
  asyncHandler(async (req, res) => {
    const body = createSchema.parse(req.body);
    const subject = await prisma.subject.findUnique({ where: { id: body.subjectId } });
    if (!subject) throw new ApiError(404, 'Subject not found');
    if (subject.ownerId !== req.userId) throw new ApiError(403, 'Only the subject owner can add topics');

    const topic = await prisma.topic.create({
      data: {
        subjectId: body.subjectId,
        name: body.name,
        description: body.description || null,
        visibility: visibilityToDb(body.visibility),
        allowCopy: body.allowCopy,
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
    const updated = await prisma.topic.update({
      where: { id: req.params.id },
      data: {
        name: body.name,
        description: body.description,
        visibility: body.visibility ? visibilityToDb(body.visibility) : undefined,
        allowCopy: body.allowCopy,
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

export default router;
