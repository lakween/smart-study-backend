import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { requireAuth } from '../middleware/auth.middleware';
import { asyncHandler, ApiError } from '../utils/asyncHandler';
import { examTypeToDb } from '../utils/mappers';
import { toExamDto } from '../utils/serializers';
import { friendshipStatusBetween } from './friends.routes';

const router = Router();
router.use(requireAuth);

const examInclude = {
  subject: true,
  topic: true,
  questions: true,
  participants: { include: { user: true } },
} as const;

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const userId = req.userId!;
    const tab = (req.query.tab as string | undefined) ?? 'mine';

    const exams =
      tab === 'invited'
        ? await prisma.exam.findMany({
            where: { organizerId: { not: userId }, participants: { some: { userId } } },
            include: examInclude,
            orderBy: { createdAt: 'desc' },
          })
        : await prisma.exam.findMany({
            where: { organizerId: userId },
            include: examInclude,
            orderBy: { createdAt: 'desc' },
          });

    res.json({ exams: exams.map(toExamDto) });
  })
);

router.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const exam = await prisma.exam.findUnique({ where: { id: req.params.id }, include: examInclude });
    if (!exam) throw new ApiError(404, 'Exam not found');
    const isParticipant = exam.organizerId === req.userId || exam.participants.some((p) => p.userId === req.userId);
    if (!isParticipant) throw new ApiError(403, 'You are not a participant in this exam');
    res.json({ exam: toExamDto(exam) });
  })
);

const createExamSchema = z.object({
  title: z.string().min(3),
  subjectId: z.string().uuid(),
  topicId: z.string().uuid(),
  type: z.enum(['individual', 'friendExam']).default('individual'),
  durationMinutes: z.number().int().positive(),
  startTime: z.string().datetime().optional(),
  participantIds: z.array(z.string().uuid()).default([]),
  questionCount: z.number().int().min(1).max(50).default(20),
});

router.post(
  '/',
  asyncHandler(async (req, res) => {
    const organizerId = req.userId!;
    const body = createExamSchema.parse(req.body);

    const pool = await prisma.question.findMany({ where: { quiz: { topicId: body.topicId } } });
    if (pool.length === 0) {
      throw new ApiError(422, 'This topic has no quiz questions yet. Add a quiz with questions before creating an exam.');
    }
    const shuffled = [...pool].sort(() => Math.random() - 0.5).slice(0, body.questionCount);

    let participantIds = [organizerId];
    if (body.type === 'friendExam') {
      for (const id of body.participantIds) {
        const status = await friendshipStatusBetween(organizerId, id);
        if (status !== 'friends') throw new ApiError(400, `User ${id} is not one of your friends`);
      }
      participantIds = Array.from(new Set([organizerId, ...body.participantIds]));
    }

    const exam = await prisma.exam.create({
      data: {
        title: body.title,
        subjectId: body.subjectId,
        topicId: body.topicId,
        type: examTypeToDb(body.type),
        status: 'SCHEDULED',
        durationMinutes: body.durationMinutes,
        startTime: body.startTime ? new Date(body.startTime) : null,
        organizerId,
        questions: {
          create: shuffled.map((q, i) => ({
            order: i,
            text: q.text,
            optionA: q.optionA,
            optionB: q.optionB,
            optionC: q.optionC,
            optionD: q.optionD,
            correctAnswer: q.correctAnswer,
            explanation: q.explanation,
          })),
        },
        participants: { create: participantIds.map((userId) => ({ userId })) },
      },
      include: examInclude,
    });

    if (body.type === 'friendExam') {
      const organizer = await prisma.user.findUniqueOrThrow({ where: { id: organizerId } });
      await prisma.notification.createMany({
        data: body.participantIds.map((userId) => ({
          userId,
          title: 'Exam Invitation',
          message: `${organizer.fullName} invited you to "${exam.title}".`,
          type: 'EXAM' as const,
          relatedId: exam.id,
        })),
      });
    }

    res.status(201).json({ exam: toExamDto(exam) });
  })
);

router.post(
  '/:id/start',
  asyncHandler(async (req, res) => {
    const exam = await prisma.exam.findUnique({ where: { id: req.params.id }, include: { participants: true } });
    if (!exam) throw new ApiError(404, 'Exam not found');
    const isParticipant = exam.organizerId === req.userId || exam.participants.some((p) => p.userId === req.userId);
    if (!isParticipant) throw new ApiError(403, 'You are not a participant in this exam');
    if (exam.status === 'SCHEDULED') {
      await prisma.exam.update({ where: { id: exam.id }, data: { status: 'STARTED' } });
    }
    res.json({ success: true });
  })
);

const submitExamSchema = z.object({
  answers: z.array(z.object({ questionId: z.string().uuid(), selectedAnswer: z.enum(['A', 'B', 'C', 'D']).nullable() })),
  timeTakenSeconds: z.number().int().nonnegative().nullable().optional(),
});

router.post(
  '/:id/submit',
  asyncHandler(async (req, res) => {
    const userId = req.userId!;
    const exam = await prisma.exam.findUnique({
      where: { id: req.params.id },
      include: { questions: true, participants: true },
    });
    if (!exam) throw new ApiError(404, 'Exam not found');
    const participant = exam.participants.find((p) => p.userId === userId);
    if (!participant) throw new ApiError(403, 'You are not a participant in this exam');

    const body = submitExamSchema.parse(req.body);
    const answerByQuestion = new Map(body.answers.map((a) => [a.questionId, a.selectedAnswer]));
    let correctCount = 0;
    for (const q of exam.questions) {
      if (answerByQuestion.get(q.id) === q.correctAnswer) correctCount++;
    }
    const scorePercent = exam.questions.length === 0 ? 0 : (correctCount / exam.questions.length) * 100;

    await prisma.examParticipant.update({
      where: { id: participant.id },
      data: { score: scorePercent, timeTakenSeconds: body.timeTakenSeconds ?? null, hasCompleted: true },
    });

    const allParticipants = await prisma.examParticipant.findMany({ where: { examId: exam.id } });
    const allDone = allParticipants.every((p) => (p.id === participant.id ? true : p.hasCompleted));
    if (allDone) {
      await prisma.exam.update({ where: { id: exam.id }, data: { status: 'COMPLETED' } });
    }

    const updated = await prisma.exam.findUniqueOrThrow({ where: { id: exam.id }, include: examInclude });
    res.json({ exam: toExamDto(updated), scorePercent, correctCount, totalQuestions: exam.questions.length });
  })
);

export default router;
