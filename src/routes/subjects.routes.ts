import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { requireAuth } from '../middleware/auth.middleware';
import { asyncHandler, ApiError } from '../utils/asyncHandler';
import { visibilityToDb } from '../utils/mappers';
import { toSubjectDto } from '../utils/serializers';
import { visibleToViewer, friendshipStatusBetween } from './friends.routes';

const router = Router();
router.use(requireAuth);

async function subjectAvgScore(subjectId: string, userId: string): Promise<number> {
  const attempts = await prisma.quizAttempt.findMany({
    where: { userId, quiz: { subjectId } },
    select: { scorePercent: true },
  });
  if (attempts.length === 0) return 0;
  return attempts.reduce((sum, a) => sum + a.scorePercent, 0) / attempts.length;
}

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const viewerId = req.userId!;
    const visibilityFilter = req.query.visibility as string | undefined;

    const subjects = await prisma.subject.findMany({
      include: { owner: true, _count: { select: { topics: true, quizzes: true } } },
      orderBy: { updatedAt: 'desc' },
    });

    const visible: typeof subjects = [];
    for (const s of subjects) {
      if (s.ownerId === viewerId) {
        visible.push(s);
        continue;
      }
      if (s.visibility === 'PUBLIC') {
        visible.push(s);
        continue;
      }
      if (s.visibility === 'FRIENDS_ONLY') {
        const status = await friendshipStatusBetween(viewerId, s.ownerId);
        if (status === 'friends') visible.push(s);
      }
    }

    const filtered = visibilityFilter
      ? visible.filter((s) => s.visibility === visibilityToDb(visibilityFilter))
      : visible;

    const dtos = await Promise.all(
      filtered.map(async (s) => toSubjectDto(s, { avgScore: await subjectAvgScore(s.id, viewerId) }))
    );
    res.json({ subjects: dtos });
  })
);

router.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const viewerId = req.userId!;
    const s = await prisma.subject.findUnique({
      where: { id: req.params.id },
      include: { owner: true, _count: { select: { topics: true, quizzes: true } } },
    });
    if (!s) throw new ApiError(404, 'Subject not found');

    const isFriend = (await friendshipStatusBetween(viewerId, s.ownerId)) === 'friends';
    if (!visibleToViewer(s.visibility, s.ownerId, viewerId, isFriend)) {
      throw new ApiError(403, 'You do not have access to this subject');
    }

    res.json({ subject: toSubjectDto(s, { avgScore: await subjectAvgScore(s.id, viewerId) }) });
  })
);

const createSchema = z.object({
  name: z.string().min(2).max(100),
  description: z.string().nullable().optional(),
  visibility: z.string().default('private'),
  allowCopy: z.boolean().default(false),
});

router.post(
  '/',
  asyncHandler(async (req, res) => {
    const body = createSchema.parse(req.body);
    const subject = await prisma.subject.create({
      data: {
        name: body.name,
        description: body.description || null,
        visibility: visibilityToDb(body.visibility),
        allowCopy: body.allowCopy,
        ownerId: req.userId!,
      },
      include: { owner: true, _count: { select: { topics: true, quizzes: true } } },
    });
    res.status(201).json({ subject: toSubjectDto(subject) });
  })
);

const updateSchema = createSchema.partial();

router.patch(
  '/:id',
  asyncHandler(async (req, res) => {
    const existing = await prisma.subject.findUnique({ where: { id: req.params.id } });
    if (!existing) throw new ApiError(404, 'Subject not found');
    if (existing.ownerId !== req.userId) throw new ApiError(403, 'Only the owner can edit this subject');

    const body = updateSchema.parse(req.body);
    const subject = await prisma.subject.update({
      where: { id: req.params.id },
      data: {
        name: body.name,
        description: body.description,
        visibility: body.visibility ? visibilityToDb(body.visibility) : undefined,
        allowCopy: body.allowCopy,
      },
      include: { owner: true, _count: { select: { topics: true, quizzes: true } } },
    });
    res.json({ subject: toSubjectDto(subject, { avgScore: await subjectAvgScore(subject.id, req.userId!) }) });
  })
);

router.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const existing = await prisma.subject.findUnique({ where: { id: req.params.id } });
    if (!existing) throw new ApiError(404, 'Subject not found');
    if (existing.ownerId !== req.userId) throw new ApiError(403, 'Only the owner can delete this subject');
    await prisma.subject.delete({ where: { id: req.params.id } });
    res.json({ success: true });
  })
);

export default router;
