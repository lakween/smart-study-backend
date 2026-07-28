import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { requireAuth } from '../middleware/auth.middleware';
import { asyncHandler, ApiError } from '../utils/asyncHandler';
import { answerOptionToDb, visibilityToDb } from '../utils/mappers';
import { toQuizDto, toQuizAttemptDto } from '../utils/serializers';
import { visibleToViewer, friendshipStatusBetween } from './friends.routes';
import { computeNextRevision } from '../utils/spacedRepetition';
import { createNotification } from '../services/notification.service';

const router = Router();
router.use(requireAuth);

async function quizExtras(quizId: string, userId: string) {
  const attempts = await prisma.quizAttempt.findMany({
    where: { quizId, userId },
    orderBy: { attemptedAt: 'desc' },
  });
  const repetition = await prisma.spacedRepetition.findUnique({ where: { userId_quizId: { userId, quizId } } });

  if (attempts.length === 0) {
    return { attemptCount: 0, bestScore: null, avgScore: null, lastAttemptDate: null, nextRevisionDate: repetition?.nextRevisionDate ?? null };
  }
  const bestScore = Math.max(...attempts.map((a) => a.scorePercent));
  const avgScore = attempts.reduce((sum, a) => sum + a.scorePercent, 0) / attempts.length;
  return {
    attemptCount: attempts.length,
    bestScore,
    avgScore,
    lastAttemptDate: attempts[0].attemptedAt,
    nextRevisionDate: repetition?.nextRevisionDate ?? null,
  };
}

const quizInclude = { subject: true, topic: true, questions: true } as const;

async function requireVisibleQuiz(quizId: string, viewerId: string) {
  const quiz = await prisma.quiz.findUnique({ where: { id: quizId }, include: quizInclude });
  if (!quiz) throw new ApiError(404, 'Quiz not found');
  const isFriend = (await friendshipStatusBetween(viewerId, quiz.ownerId)) === 'friends';
  if (!visibleToViewer(quiz.visibility, quiz.ownerId, viewerId, isFriend)) {
    throw new ApiError(403, 'You do not have access to this quiz');
  }
  return quiz;
}

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const viewerId = req.userId!;
    const query = z.object({
      filter: z.enum(['mine', 'friends', 'public', 'ai']).default('mine'),
      subjectId: z.string().uuid().optional(),
      topicId: z.string().uuid().optional(),
      search: z.string().trim().max(100).optional(),
      page: z.coerce.number().int().min(1).default(1),
      limit: z.coerce.number().int().min(1).max(50).default(20),
    }).parse(req.query);
    const filter = query.filter;
    const friendships = filter === 'mine' || filter === 'public'
      ? []
      : await prisma.friendship.findMany({
          where: {
            status: 'ACCEPTED',
            OR: [{ requesterId: viewerId }, { addresseeId: viewerId }],
          },
          select: { requesterId: true, addresseeId: true },
        });
    const friendIds = friendships.map((friendship) =>
      friendship.requesterId === viewerId ? friendship.addresseeId : friendship.requesterId,
    );

    const accessWhere = {
      OR: [
        { ownerId: viewerId },
        { visibility: 'PUBLIC' as const },
        ...(friendIds.length > 0
          ? [{ visibility: 'FRIENDS_ONLY' as const, ownerId: { in: friendIds } }]
          : []),
      ],
    };
    const filterWhere = filter === 'mine'
      ? { ownerId: viewerId }
      : filter === 'friends'
        ? { ownerId: { in: friendIds }, visibility: 'FRIENDS_ONLY' as const }
        : filter === 'public'
          ? { visibility: 'PUBLIC' as const, ownerId: { not: viewerId } }
          : { isAiGenerated: true, ...accessWhere };
    const where = {
      subjectId: query.subjectId,
      topicId: query.topicId,
      ...(query.search ? { title: { contains: query.search, mode: 'insensitive' as const } } : {}),
      ...filterWhere,
    };

    const [quizzes, total] = await prisma.$transaction([
      prisma.quiz.findMany({
      where,
      include: quizInclude,
      orderBy: { createdAt: 'desc' },
      skip: (query.page - 1) * query.limit,
      take: query.limit,
      }),
      prisma.quiz.count({ where }),
    ]);

    const quizIds = quizzes.map((quiz) => quiz.id);
    const [attemptStats, repetitions] = quizIds.length === 0
      ? [[], []] as const
      : await Promise.all([
          prisma.quizAttempt.groupBy({
            by: ['quizId'],
            where: { userId: viewerId, quizId: { in: quizIds } },
            _count: { _all: true },
            _max: { scorePercent: true, attemptedAt: true },
            _avg: { scorePercent: true },
          }),
          prisma.spacedRepetition.findMany({
            where: { userId: viewerId, quizId: { in: quizIds } },
            select: { quizId: true, nextRevisionDate: true },
          }),
        ]);
    const statsByQuiz = new Map(attemptStats.map((stats) => [stats.quizId, stats]));
    const repetitionByQuiz = new Map(repetitions.map((repetition) => [repetition.quizId, repetition]));
    const dtos = quizzes.map((quiz) => {
      const stats = statsByQuiz.get(quiz.id);
      return toQuizDto(quiz, {
        attemptCount: stats?._count._all ?? 0,
        bestScore: stats?._max.scorePercent ?? null,
        avgScore: stats?._avg.scorePercent ?? null,
        lastAttemptDate: stats?._max.attemptedAt ?? null,
        nextRevisionDate: repetitionByQuiz.get(quiz.id)?.nextRevisionDate ?? null,
        includeSolutions: quiz.ownerId === viewerId,
      });
    });
    res.json({
      quizzes: dtos,
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
    const quiz = await requireVisibleQuiz(req.params.id, viewerId);
    res.json({ quiz: toQuizDto(quiz, {
      ...await quizExtras(quiz.id, viewerId),
      includeSolutions: quiz.ownerId === viewerId,
    }) });
  })
);

const cleanText = (value: string) => value.replace(/\0/g, '').trim();
const requiredText = (minimum: number, maximum: number) =>
  z.string().transform(cleanText).pipe(z.string().min(minimum).max(maximum));

const questionSchema = z.object({
  text: requiredText(5, 500),
  optionA: requiredText(1, 250),
  optionB: requiredText(1, 250),
  optionC: requiredText(1, 250),
  optionD: requiredText(1, 250),
  correctAnswer: z.enum(['A', 'B', 'C', 'D', 'a', 'b', 'c', 'd']),
  explanation: z.string().transform(cleanText).nullable().optional(),
});

const createQuizSchema = z.object({
  title: requiredText(3, 150),
  subjectId: z.string().uuid(),
  topicId: z.string().uuid(),
  visibility: z.enum(['private', 'friendsOnly', 'public']).default('private'),
  allowCopy: z.boolean().default(false),
  isAiGenerated: z.boolean().default(false),
  timeLimitMinutes: z.number().int().min(1).max(180).nullable().optional(),
  questions: z.array(questionSchema).min(1),
});

router.post(
  '/',
  asyncHandler(async (req, res) => {
    const body = createQuizSchema.parse(req.body);
    const topic = await prisma.topic.findUnique({
      where: { id: body.topicId },
      include: { subject: true },
    });
    if (!topic || topic.subjectId !== body.subjectId) {
      throw new ApiError(400, 'The selected topic does not belong to this subject');
    }
    if (topic.subject.ownerId !== req.userId) {
      throw new ApiError(403, 'Only the subject owner can create quizzes');
    }
    const quiz = await prisma.quiz.create({
      data: {
        title: body.title,
        subjectId: body.subjectId,
        topicId: body.topicId,
        visibility: visibilityToDb(body.visibility),
        allowCopy: body.allowCopy,
        isAiGenerated: body.isAiGenerated,
        timeLimitMinutes: body.timeLimitMinutes ?? null,
        ownerId: req.userId!,
        questions: {
          create: body.questions.map((q, i) => ({
            order: i,
            text: q.text,
            optionA: q.optionA,
            optionB: q.optionB,
            optionC: q.optionC,
            optionD: q.optionD,
            correctAnswer: answerOptionToDb(q.correctAnswer)!,
            explanation: q.explanation || null,
          })),
        },
      },
      include: quizInclude,
    });
    res.status(201).json({ quiz: toQuizDto(quiz, { includeSolutions: true }) });
  })
);

const updateQuizSchema = createQuizSchema.partial();

router.patch(
  '/:id',
  asyncHandler(async (req, res) => {
    const existing = await prisma.quiz.findUnique({ where: { id: req.params.id } });
    if (!existing) throw new ApiError(404, 'Quiz not found');
    if (existing.ownerId !== req.userId) throw new ApiError(403, 'Only the owner can edit this quiz');

    const body = updateQuizSchema.parse(req.body);

    const nextSubjectId = body.subjectId ?? existing.subjectId;
    const nextTopicId = body.topicId ?? existing.topicId;
    const topic = await prisma.topic.findUnique({
      where: { id: nextTopicId },
      include: { subject: true },
    });
    if (!topic || topic.subjectId !== nextSubjectId) {
      throw new ApiError(400, 'The selected topic does not belong to this subject');
    }
    if (topic.subject.ownerId !== req.userId) {
      throw new ApiError(403, 'Only the subject owner can move or edit this quiz');
    }

    await prisma.$transaction(async (tx) => {
      await tx.quiz.update({
        where: { id: req.params.id },
        data: {
          title: body.title,
          subjectId: body.subjectId,
          topicId: body.topicId,
          visibility: body.visibility ? visibilityToDb(body.visibility) : undefined,
          allowCopy: body.allowCopy,
          timeLimitMinutes: body.timeLimitMinutes,
        },
      });

      if (body.questions) {
        await tx.question.deleteMany({ where: { quizId: req.params.id } });
        await tx.question.createMany({
          data: body.questions.map((q, i) => ({
            quizId: req.params.id,
            order: i,
            text: q.text,
            optionA: q.optionA,
            optionB: q.optionB,
            optionC: q.optionC,
            optionD: q.optionD,
            correctAnswer: answerOptionToDb(q.correctAnswer)!,
            explanation: q.explanation || null,
          })),
        });
      }
    });

    const updated = await prisma.quiz.findUniqueOrThrow({ where: { id: req.params.id }, include: quizInclude });
    res.json({ quiz: toQuizDto(updated, {
      ...await quizExtras(updated.id, req.userId!),
      includeSolutions: true,
    }) });
  })
);

router.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const existing = await prisma.quiz.findUnique({ where: { id: req.params.id } });
    if (!existing) throw new ApiError(404, 'Quiz not found');
    if (existing.ownerId !== req.userId) throw new ApiError(403, 'Only the owner can delete this quiz');
    await prisma.quiz.delete({ where: { id: req.params.id } });
    res.json({ success: true });
  })
);

const submitAttemptSchema = z.object({
  sessionId: z.string().uuid(),
  answers: z.array(z.object({ questionId: z.string().uuid(), selectedAnswer: z.enum(['A', 'B', 'C', 'D']).nullable() })).max(500),
}).superRefine((body, ctx) => {
  const ids = body.answers.map((answer) => answer.questionId);
  if (new Set(ids).size !== ids.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['answers'], message: 'Each question can only be answered once' });
  }
});

const startAttemptSchema = z.object({ mode: z.enum(['timed', 'untimed']) });

router.post(
  '/:id/sessions',
  asyncHandler(async (req, res) => {
    const userId = req.userId!;
    const quiz = await requireVisibleQuiz(req.params.id, userId);
    const body = startAttemptSchema.parse(req.body);
    if (body.mode === 'timed' && quiz.timeLimitMinutes == null) {
      throw new ApiError(400, 'This quiz does not have a timed practice mode');
    }

    const startedAt = new Date();
    const deadlineAt = body.mode === 'timed'
      ? new Date(startedAt.getTime() + quiz.timeLimitMinutes! * 60_000)
      : null;
    const session = await prisma.quizSession.create({
      data: {
        quizId: quiz.id,
        userId,
        mode: body.mode === 'timed' ? 'TIMED' : 'UNTIMED',
        startedAt,
        deadlineAt,
      },
    });

    res.status(201).json({
      session: {
        id: session.id,
        mode: body.mode,
        startedAt: session.startedAt,
        deadlineAt: session.deadlineAt,
      },
    });
  }),
);

router.post(
  '/:id/attempts',
  asyncHandler(async (req, res) => {
    const userId = req.userId!;
    const body = submitAttemptSchema.parse(req.body);
    const quiz = await requireVisibleQuiz(req.params.id, userId);
    const session = await prisma.quizSession.findUnique({ where: { id: body.sessionId } });
    if (!session || session.quizId !== quiz.id || session.userId !== userId) {
      throw new ApiError(404, 'Practice session not found');
    }
    if (session.submittedAt) throw new ApiError(409, 'This practice session was already submitted');

    const submittedAt = new Date();
    const submissionGraceMs = 30_000;
    if (session.deadlineAt && submittedAt.getTime() > session.deadlineAt.getTime() + submissionGraceMs) {
      throw new ApiError(409, 'This timed practice session has expired');
    }

    const answerByQuestion = new Map(body.answers.map((a) => [a.questionId, a.selectedAnswer]));

    let correctCount = 0;
    const answerRows = quiz.questions.map((q) => {
      const selected = answerByQuestion.get(q.id) ?? null;
      const isCorrect = selected === q.correctAnswer;
      if (isCorrect) correctCount++;
      return { questionId: q.id, selectedAnswer: selected, isCorrect };
    });

    const totalQuestions = quiz.questions.length;
    const scorePercent = totalQuestions === 0 ? 0 : (correctCount / totalQuestions) * 100;

    const effectiveEnd = session.deadlineAt && submittedAt > session.deadlineAt ? session.deadlineAt : submittedAt;
    const timeTakenSeconds = Math.max(0, Math.floor((effectiveEnd.getTime() - session.startedAt.getTime()) / 1000));

    const existingRepetition = await prisma.spacedRepetition.findUnique({ where: { userId_quizId: { userId, quizId: quiz.id } } });
    const { intervalDays, nextRevisionDate } = computeNextRevision(existingRepetition?.intervalDays ?? null, scorePercent);

    const attempt = await prisma.$transaction(async (tx) => {
      const claimed = await tx.quizSession.updateMany({
        where: { id: session.id, submittedAt: null },
        data: { submittedAt },
      });
      if (claimed.count !== 1) throw new ApiError(409, 'This practice session was already submitted');

      const createdAttempt = await tx.quizAttempt.create({
        data: {
          quizId: quiz.id,
          userId,
          sessionId: session.id,
          correctCount,
          totalQuestions,
          scorePercent,
          timeTakenSeconds,
          answers: { create: answerRows },
        },
        include: { quiz: true, answers: true },
      });

      await tx.spacedRepetition.upsert({
        where: { userId_quizId: { userId, quizId: quiz.id } },
        create: { userId, quizId: quiz.id, topicId: quiz.topicId, lastScore: scorePercent, intervalDays, nextRevisionDate },
        update: { lastScore: scorePercent, intervalDays, nextRevisionDate },
      });
      return createdAttempt;
    });

    try {
      await createNotification({
        userId,
        title: 'Quiz Completed Successfully',
        message: `You scored ${scorePercent.toFixed(0)}% on ${quiz.title}.`,
        type: 'QUIZ',
        relatedId: quiz.id,
      });
    } catch (error) {
      console.error(JSON.stringify({
        level: 'error',
        event: 'quiz_completion_notification_failed',
        userId,
        quizId: quiz.id,
        error: error instanceof Error ? error.message : String(error),
      }));
    }

    res.status(201).json({
      attempt: toQuizAttemptDto(attempt),
      quiz: toQuizDto(quiz, {
        ...await quizExtras(quiz.id, userId),
        includeSolutions: true,
      }),
      nextRevisionDate,
    });
  })
);

router.get(
  '/:id/attempts/:attemptId',
  asyncHandler(async (req, res) => {
    const attempt = await prisma.quizAttempt.findUnique({
      where: { id: req.params.attemptId },
      include: { quiz: { include: { subject: true, topic: true, questions: true } }, answers: true },
    });
    if (!attempt || attempt.quizId !== req.params.id) throw new ApiError(404, 'Attempt not found');
    if (attempt.userId !== req.userId) throw new ApiError(403, 'You do not have access to this attempt');
    res.json({
      attempt: toQuizAttemptDto(attempt),
      quiz: toQuizDto(attempt.quiz, { includeSolutions: true }),
    });
  })
);

export default router;
