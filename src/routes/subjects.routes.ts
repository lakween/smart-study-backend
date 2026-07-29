import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { requireAuth } from '../middleware/auth.middleware';
import { asyncHandler, ApiError } from '../utils/asyncHandler';
import { visibilityToDb } from '../utils/mappers';
import { toSubjectDto } from '../utils/serializers';
import { visibleToViewer, friendshipStatusBetween } from './friends.routes';
import { subjectCopyCounts } from '../utils/copyStats';

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
    const query = z.object({
      visibility: z.enum(['private', 'friendsOnly', 'public']).optional(),
      search: z.string().trim().max(100).default(''),
      archived: z.enum(['true', 'false']).default('false'),
      sort: z.enum(['updated', 'name', 'created']).default('updated'),
      page: z.coerce.number().int().min(1).default(1),
      limit: z.coerce.number().int().min(1).max(50).default(20),
    }).parse(req.query);
    const where = {
      ownerId: viewerId,
      visibility: query.visibility ? visibilityToDb(query.visibility) : undefined,
      isArchived: query.archived === 'true',
      ...(query.search ? { name: { contains: query.search, mode: 'insensitive' as const } } : {}),
    };
    const orderBy = query.sort === 'name'
      ? { name: 'asc' as const }
      : query.sort === 'created'
        ? { createdAt: 'desc' as const }
        : { updatedAt: 'desc' as const };

    const [subjects, total] = await prisma.$transaction([
      prisma.subject.findMany({
        where,
        include: { owner: true, _count: { select: { topics: true, quizzes: true } } },
        orderBy,
        skip: (query.page - 1) * query.limit,
        take: query.limit,
      }),
      prisma.subject.count({ where }),
    ]);

    const attempts = subjects.length === 0 ? [] : await prisma.quizAttempt.findMany({
      where: { userId: viewerId, quiz: { subjectId: { in: subjects.map((subject) => subject.id) } } },
      select: { scorePercent: true, quiz: { select: { subjectId: true } } },
    });
    const scoresBySubject = new Map<string, number[]>();
    for (const attempt of attempts) {
      const scores = scoresBySubject.get(attempt.quiz.subjectId) ?? [];
      scores.push(attempt.scorePercent);
      scoresBySubject.set(attempt.quiz.subjectId, scores);
    }
    const copiedBy = await subjectCopyCounts(subjects.map((subject) => subject.id));
    const dtos = subjects.map((subject) => {
      const scores = scoresBySubject.get(subject.id) ?? [];
      const avgScore = scores.length === 0 ? 0 : scores.reduce((sum, score) => sum + score, 0) / scores.length;
      return toSubjectDto(subject, { avgScore, copiedByCount: copiedBy.get(subject.id) ?? 0 });
    });
    res.json({
      subjects: dtos,
      pagination: {
        page: query.page,
        limit: query.limit,
        total,
        hasMore: query.page * query.limit < total,
      },
    });
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

    const copiedBy = await subjectCopyCounts([s.id]);
    res.json({ subject: toSubjectDto(s, {
      avgScore: await subjectAvgScore(s.id, viewerId),
      copiedByCount: copiedBy.get(s.id) ?? 0,
    }) });
  })
);

const cleanText = (value: string) => value.replace(/\0/g, '').trim();

const createSchema = z.object({
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
    const subject = await prisma.subject.create({
      data: {
        name: body.name,
        description: body.description || null,
        visibility: visibilityToDb(body.visibility),
        allowCopy: body.allowCopy,
        isArchived: body.isArchived,
        ownerId: req.userId!,
      },
      include: { owner: true, _count: { select: { topics: true, quizzes: true } } },
    });
    res.status(201).json({ subject: toSubjectDto(subject) });
  })
);

const copySubjectSchema = z.object({
  name: z.string().transform(cleanText).pipe(z.string().min(2).max(100)).optional(),
});

router.post(
  '/:id/copy',
  asyncHandler(async (req, res) => {
    const viewerId = req.userId!;
    const body = copySubjectSchema.parse(req.body);
    const source = await prisma.subject.findUnique({
      where: { id: req.params.id },
      include: {
        owner: true,
        topics: { include: { quizzes: { include: { questions: { orderBy: { order: 'asc' } } } } } },
        documents: true,
      },
    });
    if (!source) throw new ApiError(404, 'Subject not found');

    const isFriend = (await friendshipStatusBetween(viewerId, source.ownerId)) === 'friends';
    if (!visibleToViewer(source.visibility, source.ownerId, viewerId, isFriend)) {
      throw new ApiError(403, 'You do not have access to this subject');
    }
    if (source.ownerId !== viewerId && !source.allowCopy) {
      throw new ApiError(403, 'The owner has not allowed copying this subject');
    }

    const result = await prisma.$transaction(async (tx) => {
      const copiedSubject = await tx.subject.create({
        data: {
          name: body.name ?? `${source.name} (Copy)`,
          description: source.description,
          visibility: 'PRIVATE',
          allowCopy: false,
          ownerId: viewerId,
          originalCreatorId: source.originalCreatorId ?? source.ownerId,
          originalCreatorName: source.originalCreatorName ?? source.owner.fullName,
          copiedFromId: source.id,
        },
      });

      const topicIds = new Map<string, string>();
      let copiedTopics = 0;
      let copiedQuizzes = 0;
      let copiedDocuments = 0;

      for (const topic of source.topics) {
        if (!topic.allowCopy || !visibleToViewer(topic.visibility, source.ownerId, viewerId, isFriend)) continue;
        const copiedTopic = await tx.topic.create({
          data: {
            subjectId: copiedSubject.id,
            name: topic.name,
            description: topic.description,
            visibility: 'PRIVATE',
            allowCopy: false,
            originalCreatorId: topic.originalCreatorId ?? source.ownerId,
            originalCreatorName: topic.originalCreatorName ?? source.owner.fullName,
            copiedFromId: topic.id,
          },
        });
        topicIds.set(topic.id, copiedTopic.id);
        copiedTopics += 1;

        for (const quiz of topic.quizzes) {
          if (!quiz.allowCopy || !visibleToViewer(quiz.visibility, source.ownerId, viewerId, isFriend)) continue;
          await tx.quiz.create({
            data: {
              title: quiz.title,
              subjectId: copiedSubject.id,
              topicId: copiedTopic.id,
              visibility: 'PRIVATE',
              allowCopy: false,
              isAiGenerated: quiz.isAiGenerated,
              timeLimitMinutes: quiz.timeLimitMinutes,
              ownerId: viewerId,
              originalCreatorId: quiz.originalCreatorId ?? source.ownerId,
              originalCreatorName: quiz.originalCreatorName ?? source.owner.fullName,
              copiedFromId: quiz.id,
              questions: {
                create: quiz.questions.map((question) => ({
                  order: question.order,
                  text: question.text,
                  optionA: question.optionA,
                  optionB: question.optionB,
                  optionC: question.optionC,
                  optionD: question.optionD,
                  correctAnswer: question.correctAnswer,
                  explanation: question.explanation,
                })),
              },
            },
          });
          copiedQuizzes += 1;
        }
      }

      for (const document of source.documents) {
        if (!document.allowCopy || !visibleToViewer(document.visibility, source.ownerId, viewerId, isFriend)) continue;
        const copiedTopicId = document.topicId ? topicIds.get(document.topicId) : null;
        if (document.topicId && !copiedTopicId) continue;
        await tx.document.create({
          data: {
            title: document.title,
            subjectId: copiedSubject.id,
            topicId: copiedTopicId ?? null,
            fileUrl: document.fileUrl,
            fileType: document.fileType,
            fileSizeBytes: document.fileSizeBytes,
            visibility: 'PRIVATE',
            allowCopy: false,
            ownerId: viewerId,
            originalCreatorId: document.originalCreatorId ?? source.ownerId,
            originalCreatorName: document.originalCreatorName ?? source.owner.fullName,
            copiedFromId: document.id,
          },
        });
        copiedDocuments += 1;
      }

      const subject = await tx.subject.findUniqueOrThrow({
        where: { id: copiedSubject.id },
        include: { owner: true, _count: { select: { topics: true, quizzes: true } } },
      });
      return { subject, copiedTopics, copiedQuizzes, copiedDocuments };
    });

    res.status(201).json({
      subject: toSubjectDto(result.subject),
      copied: {
        topics: result.copiedTopics,
        quizzes: result.copiedQuizzes,
        documents: result.copiedDocuments,
      },
    });
  }),
);

const updateSchema = createSchema.partial();

router.patch(
  '/:id',
  asyncHandler(async (req, res) => {
    const existing = await prisma.subject.findUnique({ where: { id: req.params.id } });
    if (!existing) throw new ApiError(404, 'Subject not found');
    if (existing.ownerId !== req.userId) throw new ApiError(403, 'Only the owner can edit this subject');

    const body = updateSchema.parse(req.body);
    await prisma.$transaction(async (tx) => {
      const visibility = body.visibility ? visibilityToDb(body.visibility) : undefined;
      await tx.subject.update({
        where: { id: req.params.id },
        data: {
          name: body.name,
          description: body.description,
          visibility,
          allowCopy: body.allowCopy,
          isArchived: body.isArchived,
        },
      });

      // Children must never be more visible than their parent subject.
      if (visibility === 'PRIVATE') {
        await Promise.all([
          tx.topic.updateMany({ where: { subjectId: req.params.id }, data: { visibility: 'PRIVATE' } }),
          tx.quiz.updateMany({ where: { subjectId: req.params.id }, data: { visibility: 'PRIVATE' } }),
          tx.document.updateMany({ where: { subjectId: req.params.id }, data: { visibility: 'PRIVATE' } }),
        ]);
      } else if (visibility === 'FRIENDS_ONLY') {
        await Promise.all([
          tx.topic.updateMany({ where: { subjectId: req.params.id, visibility: 'PUBLIC' }, data: { visibility: 'FRIENDS_ONLY' } }),
          tx.quiz.updateMany({ where: { subjectId: req.params.id, visibility: 'PUBLIC' }, data: { visibility: 'FRIENDS_ONLY' } }),
          tx.document.updateMany({ where: { subjectId: req.params.id, visibility: 'PUBLIC' }, data: { visibility: 'FRIENDS_ONLY' } }),
        ]);
      }
    });
    const subject = await prisma.subject.findUniqueOrThrow({
      where: { id: req.params.id },
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
