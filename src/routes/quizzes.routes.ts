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

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const viewerId = req.userId!;
    const filter = req.query.filter as string | undefined; // mine | friends | public | ai
    const subjectId = req.query.subjectId as string | undefined;
    const topicId = req.query.topicId as string | undefined;

    const quizzes = await prisma.quiz.findMany({
      where: { subjectId, topicId },
      include: quizInclude,
      orderBy: { createdAt: 'desc' },
    });

    const visible = [];
    for (const q of quizzes) {
      if (q.ownerId === viewerId) {
        visible.push(q);
        continue;
      }
      const isFriend = (await friendshipStatusBetween(viewerId, q.ownerId)) === 'friends';
      if (visibleToViewer(q.visibility, q.ownerId, viewerId, isFriend)) visible.push(q);
    }

    let filtered = visible;
    if (filter === 'mine') filtered = visible.filter((q) => q.ownerId === viewerId);
    else if (filter === 'friends') filtered = visible.filter((q) => q.ownerId !== viewerId && q.visibility !== 'PUBLIC');
    else if (filter === 'public') filtered = visible.filter((q) => q.visibility === 'PUBLIC');
    else if (filter === 'ai') filtered = visible.filter((q) => q.isAiGenerated);

    const dtos = await Promise.all(filtered.map(async (q) => toQuizDto(q, await quizExtras(q.id, viewerId))));
    res.json({ quizzes: dtos });
  })
);

router.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const viewerId = req.userId!;
    const quiz = await prisma.quiz.findUnique({ where: { id: req.params.id }, include: quizInclude });
    if (!quiz) throw new ApiError(404, 'Quiz not found');
    const isFriend = (await friendshipStatusBetween(viewerId, quiz.ownerId)) === 'friends';
    if (!visibleToViewer(quiz.visibility, quiz.ownerId, viewerId, isFriend)) {
      throw new ApiError(403, 'You do not have access to this quiz');
    }
    res.json({ quiz: toQuizDto(quiz, await quizExtras(quiz.id, viewerId)) });
  })
);

const questionSchema = z.object({
  text: z.string().min(5),
  optionA: z.string().min(1),
  optionB: z.string().min(1),
  optionC: z.string().min(1),
  optionD: z.string().min(1),
  correctAnswer: z.enum(['A', 'B', 'C', 'D', 'a', 'b', 'c', 'd']),
  explanation: z.string().nullable().optional(),
});

const createQuizSchema = z.object({
  title: z.string().min(3),
  subjectId: z.string().uuid(),
  topicId: z.string().uuid(),
  visibility: z.string().default('private'),
  allowCopy: z.boolean().default(false),
  isAiGenerated: z.boolean().default(false),
  timeLimitMinutes: z.number().int().positive().nullable().optional(),
  questions: z.array(questionSchema).min(1),
});

router.post(
  '/',
  asyncHandler(async (req, res) => {
    const body = createQuizSchema.parse(req.body);
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
    res.status(201).json({ quiz: toQuizDto(quiz) });
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
    res.json({ quiz: toQuizDto(updated, await quizExtras(updated.id, req.userId!)) });
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
  answers: z.array(z.object({ questionId: z.string().uuid(), selectedAnswer: z.enum(['A', 'B', 'C', 'D']).nullable() })),
  timeTakenSeconds: z.number().int().nonnegative().nullable().optional(),
});

router.post(
  '/:id/attempts',
  asyncHandler(async (req, res) => {
    const userId = req.userId!;
    const quiz = await prisma.quiz.findUnique({ where: { id: req.params.id }, include: { questions: true } });
    if (!quiz) throw new ApiError(404, 'Quiz not found');

    const body = submitAttemptSchema.parse(req.body);
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

    const attempt = await prisma.quizAttempt.create({
      data: {
        quizId: quiz.id,
        userId,
        correctCount,
        totalQuestions,
        scorePercent,
        timeTakenSeconds: body.timeTakenSeconds ?? null,
        answers: { create: answerRows },
      },
      include: { quiz: true, answers: true },
    });

    const existingRepetition = await prisma.spacedRepetition.findUnique({ where: { userId_quizId: { userId, quizId: quiz.id } } });
    const { intervalDays, nextRevisionDate } = computeNextRevision(existingRepetition?.intervalDays ?? null, scorePercent);
    await prisma.spacedRepetition.upsert({
      where: { userId_quizId: { userId, quizId: quiz.id } },
      create: { userId, quizId: quiz.id, topicId: quiz.topicId, lastScore: scorePercent, intervalDays, nextRevisionDate },
      update: { lastScore: scorePercent, intervalDays, nextRevisionDate },
    });

    await createNotification({
      userId,
      title: 'Quiz Completed Successfully',
      message: `You scored ${scorePercent.toFixed(0)}% on ${quiz.title}.`,
      type: 'QUIZ',
      relatedId: quiz.id,
    });

    res.status(201).json({ attempt: toQuizAttemptDto(attempt), nextRevisionDate });
  })
);

router.get(
  '/:id/attempts/:attemptId',
  asyncHandler(async (req, res) => {
    const attempt = await prisma.quizAttempt.findUnique({
      where: { id: req.params.attemptId },
      include: { quiz: true, answers: true },
    });
    if (!attempt || attempt.quizId !== req.params.id) throw new ApiError(404, 'Attempt not found');
    if (attempt.userId !== req.userId) throw new ApiError(403, 'You do not have access to this attempt');
    res.json({ attempt: toQuizAttemptDto(attempt) });
  })
);

export default router;
