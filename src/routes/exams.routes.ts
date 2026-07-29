import { AnswerOption, Prisma } from '@prisma/client';
import { Router } from 'express';
import { z } from 'zod';

import { requireAuth } from '../middleware/auth.middleware';
import { emitExamChanged } from '../realtime/socket';
import {
  calculateExamScore,
  canReleaseSolutions,
  effectiveExamStatus,
  examDeadline,
  shuffledIds,
} from '../services/exam.service';
import { createNotification } from '../services/notification.service';
import { asyncHandler, ApiError } from '../utils/asyncHandler';
import { examStatusFromDb, examTypeFromDb, examTypeToDb } from '../utils/mappers';
import { prisma } from '../lib/prisma';
import { friendshipStatusBetween } from './friends.routes';

const router = Router();
router.use(requireAuth);

const summaryInclude = {
  subject: true,
  topic: true,
  _count: { select: { questions: true } },
  participants: { include: { user: true } },
  invitations: { include: { user: true } },
  attempts: true,
} as const;

const attemptInclude = {
  exam: {
    include: {
      subject: true,
      topic: true,
      questions: { orderBy: { order: 'asc' as const } },
      participants: { include: { user: true } },
      invitations: { include: { user: true } },
    },
  },
  answers: true,
} as const;

const answerSchema = z.object({
  questionId: z.string().uuid(),
  selectedAnswer: z.enum(['A', 'B', 'C', 'D']).nullable(),
});

const examInputSchema = z.object({
  title: z.string().trim().min(3).max(120),
  subjectId: z.string().uuid(),
  topicId: z.string().uuid(),
  type: z.enum(['individual', 'friendExam']).default('individual'),
  durationMinutes: z.number().int().min(5).max(240),
  startTime: z.string().datetime().optional().nullable(),
  participantIds: z.array(z.string().uuid()).max(50).default([]),
  questionCount: z.number().int().min(1).max(50).default(20),
  passPercent: z.number().int().min(1).max(100).default(60),
  shuffleQuestions: z.boolean().default(true),
  publish: z.boolean().default(true),
});

function sanitizedQuestion(question: any, includeSolution = false) {
  return {
    id: question.id,
    text: question.text,
    optionA: question.optionA,
    optionB: question.optionB,
    optionC: question.optionC,
    optionD: question.optionD,
    ...(includeSolution
      ? { correctAnswer: question.correctAnswer, explanation: question.explanation }
      : {}),
  };
}

function invitationStatus(value?: string | null) {
  if (!value) return null;
  return value.toLowerCase();
}

function attemptStatus(value?: string | null) {
  if (!value) return null;
  if (value === 'AUTO_SUBMITTED') return 'autoSubmitted';
  return value === 'IN_PROGRESS' ? 'inProgress' : 'submitted';
}

function examSummary(exam: any, userId: string, revealResults = false) {
  const invitation = exam.invitations?.find((item: any) => item.userId === userId);
  const attempt = exam.attempts?.find((item: any) => item.userId === userId);
  const invitations = exam.invitations ?? [];
  const participants = exam.participants ?? [];
  const isOrganizer = exam.organizerId === userId;
  const effectiveStatus = effectiveExamStatus(
    exam.status,
    exam.startTime,
    exam.closesAt,
  );
  const resultsVisible = revealResults || effectiveStatus === 'COMPLETED';

  return {
    id: exam.id,
    title: exam.title,
    subjectId: exam.subjectId,
    subjectName: exam.subject?.name ?? '',
    topicId: exam.topicId,
    topicName: exam.topic?.name ?? '',
    type: examTypeFromDb(exam.type),
    status: examStatusFromDb(effectiveStatus),
    durationMinutes: exam.durationMinutes,
    startTime: exam.startTime,
    closesAt: exam.closesAt,
    questionCount: exam._count?.questions ?? exam.questions?.length ?? exam.questionCount,
    passPercent: exam.passPercent,
    shuffleQuestions: exam.shuffleQuestions,
    resultRelease: exam.resultRelease === 'AFTER_CLOSE' ? 'afterClose' : 'afterSubmission',
    publishedAt: exam.publishedAt,
    organizerId: exam.organizerId,
    invitationStatus: invitationStatus(invitation?.status),
    attemptStatus: attemptStatus(attempt?.status),
    invitedCount: isOrganizer ? invitations.length : null,
    acceptedInvitationCount: isOrganizer
      ? invitations.filter((item: any) => item.status === 'ACCEPTED').length
      : null,
    pendingInvitationCount: isOrganizer
      ? invitations.filter((item: any) => item.status === 'PENDING').length
      : null,
    declinedInvitationCount: isOrganizer
      ? invitations.filter((item: any) => item.status === 'DECLINED').length
      : null,
    submittedCount: participants.filter((participant: any) => participant.hasCompleted).length,
    participants: participants.map((participant: any) => ({
      userId: participant.userId,
      name: participant.user?.fullName ?? '',
      imageUrl: participant.user?.profileImageUrl,
      score: resultsVisible ? participant.score : null,
      timeTakenSeconds: resultsVisible ? participant.timeTakenSeconds : null,
      hasCompleted: participant.hasCompleted,
    })),
    createdAt: exam.createdAt,
  };
}

function attemptDto(attempt: any, includeSolutions = false) {
  const answerByQuestion = new Map(
    (attempt.answers ?? []).map((answer: any) => [answer.questionId, answer.selectedAnswer]),
  );
  const questionById = new Map(
    attempt.exam.questions.map((question: any) => [question.id, question]),
  );
  const order = Array.isArray(attempt.questionOrder)
    ? (attempt.questionOrder as string[])
    : attempt.exam.questions.map((question: any) => question.id);

  return {
    id: attempt.id,
    examId: attempt.examId,
    status: attemptStatus(attempt.status),
    startedAt: attempt.startedAt,
    deadlineAt: attempt.deadlineAt,
    submittedAt: attempt.submittedAt,
    scorePercent: includeSolutions ? attempt.scorePercent : null,
    correctCount: includeSolutions ? attempt.correctCount : null,
    totalQuestions: attempt.totalQuestions,
    questions: order
      .map((id: string) => questionById.get(id))
      .filter(Boolean)
      .map((question: any) => sanitizedQuestion(question, includeSolutions)),
    answers: Object.fromEntries(answerByQuestion),
  };
}

async function notifyMany(
  userIds: string[],
  input: { title: string; message: string; relatedId: string },
) {
  await Promise.allSettled(
    [...new Set(userIds)].map((userId) =>
      createNotification({ userId, type: 'EXAM', ...input }),
    ),
  );
}

async function assertOwnedHierarchy(userId: string, subjectId: string, topicId: string) {
  const topic = await prisma.topic.findFirst({
    where: { id: topicId, subjectId, subject: { ownerId: userId }, isArchived: false },
    select: { id: true },
  });
  if (!topic) {
    throw new ApiError(403, 'Choose an active topic from one of your subjects');
  }
}

async function assertFriends(organizerId: string, participantIds: string[]) {
  for (const participantId of [...new Set(participantIds)]) {
    if (participantId === organizerId) continue;
    const status = await friendshipStatusBetween(organizerId, participantId);
    if (status !== 'friends') {
      throw new ApiError(400, 'Every invited participant must be an accepted friend');
    }
  }
}

async function accessibleExam(examId: string, userId: string) {
  const exam = await prisma.exam.findFirst({
    where: {
      id: examId,
      OR: [
        { organizerId: userId },
        { participants: { some: { userId } } },
        { invitations: { some: { userId, status: { in: ['PENDING', 'ACCEPTED'] } } } },
      ],
    },
    include: summaryInclude,
  });
  if (!exam) throw new ApiError(404, 'Exam not found');
  return exam;
}

async function publishExam(examId: string, organizerId: string, participantIds: string[]) {
  const exam = await prisma.exam.findUnique({ where: { id: examId } });
  if (!exam) throw new ApiError(404, 'Exam not found');
  if (exam.organizerId !== organizerId) throw new ApiError(403, 'Only the organizer can publish this exam');
  if (exam.status !== 'DRAFT') throw new ApiError(409, 'Only draft exams can be published');

  const invitees = exam.type === 'FRIEND_EXAM'
    ? [...new Set(participantIds.filter((id) => id !== organizerId))]
    : [];
  if (exam.type === 'FRIEND_EXAM' && invitees.length === 0) {
    throw new ApiError(422, 'Select at least one friend for a friend exam');
  }
  await assertFriends(organizerId, invitees);

  const pool = await prisma.question.findMany({
    where: { quiz: { topicId: exam.topicId } },
    orderBy: { order: 'asc' },
  });
  if (pool.length === 0) {
    throw new ApiError(422, 'This topic has no quiz questions yet. Add a quiz before publishing the exam.');
  }

  const selectedIds = shuffledIds(pool.map((question) => question.id)).slice(0, exam.questionCount);
  const questionById = new Map(pool.map((question) => [question.id, question]));
  const selected = selectedIds.map((id) => questionById.get(id)!);
  const now = new Date();
  const startsAt = exam.startTime ?? now;
  const closesAt = new Date(startsAt.getTime() + exam.durationMinutes * 60_000);
  const status = startsAt > now ? 'SCHEDULED' : 'STARTED';

  const published = await prisma.$transaction(async (tx) => {
    await tx.question.deleteMany({ where: { examId } });
    await tx.examInvitation.deleteMany({ where: { examId } });
    await tx.question.createMany({
      data: selected.map((question, order) => ({
        examId,
        order,
        text: question.text,
        optionA: question.optionA,
        optionB: question.optionB,
        optionC: question.optionC,
        optionD: question.optionD,
        correctAnswer: question.correctAnswer,
        explanation: question.explanation,
      })),
    });
    if (invitees.length > 0) {
      await tx.examInvitation.createMany({
        data: invitees.map((userId) => ({ examId, userId })),
      });
    }
    return tx.exam.update({
      where: { id: examId },
      data: {
        status,
        startTime: startsAt,
        closesAt,
        publishedAt: now,
        resultRelease: exam.type === 'FRIEND_EXAM' ? 'AFTER_CLOSE' : 'AFTER_SUBMISSION',
      },
      include: summaryInclude,
    });
  });

  if (invitees.length > 0) {
    const organizer = await prisma.user.findUniqueOrThrow({ where: { id: organizerId } });
    await notifyMany(invitees, {
      title: 'Exam invitation',
      message: `${organizer.fullName} invited you to “${published.title}”.`,
      relatedId: published.id,
    });
    emitExamChanged(invitees, { examId: published.id, action: 'invited' });
  }
  return published;
}

async function startOrResumeAttempt(examId: string, userId: string) {
  const existing = await prisma.examAttempt.findUnique({
    where: { examId_userId: { examId, userId } },
    include: attemptInclude,
  });
  if (existing) return existing;

  const exam = await prisma.exam.findUnique({
    where: { id: examId },
    include: {
      questions: { orderBy: { order: 'asc' } },
      participants: true,
      invitations: true,
    },
  });
  if (!exam) throw new ApiError(404, 'Exam not found');
  if (!exam.publishedAt || exam.status === 'DRAFT') throw new ApiError(409, 'This exam has not been published');
  if (exam.status === 'CANCELLED') throw new ApiError(409, 'This exam was cancelled');
  const participant = exam.participants.some((item) => item.userId === userId);
  if (!participant) {
    const pending = exam.invitations.some((item) => item.userId === userId && item.status === 'PENDING');
    throw new ApiError(403, pending ? 'Accept the invitation before starting' : 'You are not a participant in this exam');
  }

  const now = new Date();
  const effectiveStatus = effectiveExamStatus(exam.status, exam.startTime, exam.closesAt, now);
  if (effectiveStatus === 'SCHEDULED') {
    throw new ApiError(409, `This exam opens at ${exam.startTime!.toISOString()}`);
  }
  if (effectiveStatus === 'COMPLETED' || (exam.closesAt && now >= exam.closesAt)) {
    throw new ApiError(409, 'This exam is closed');
  }
  if (exam.questions.length === 0) throw new ApiError(422, 'This exam has no questions');

  const order = exam.shuffleQuestions
    ? shuffledIds(exam.questions.map((question) => question.id))
    : exam.questions.map((question) => question.id);
  const deadlineAt = examDeadline(now, exam.durationMinutes, exam.closesAt);
  try {
    return await prisma.examAttempt.create({
      data: {
        examId,
        userId,
        deadlineAt,
        totalQuestions: exam.questions.length,
        questionOrder: order,
      },
      include: attemptInclude,
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      return prisma.examAttempt.findUniqueOrThrow({
        where: { examId_userId: { examId, userId } },
        include: attemptInclude,
      });
    }
    throw error;
  }
}

async function persistAnswers(attemptId: string, userId: string, answers: z.infer<typeof answerSchema>[]) {
  const attempt = await prisma.examAttempt.findFirst({
    where: { id: attemptId, userId },
    include: { exam: { include: { questions: { select: { id: true } } } } },
  });
  if (!attempt) throw new ApiError(404, 'Exam attempt not found');
  if (attempt.status !== 'IN_PROGRESS') throw new ApiError(409, 'This exam attempt is already submitted');
  if (new Date() >= attempt.deadlineAt) return attempt;
  const allowed = new Set(attempt.exam.questions.map((question) => question.id));
  if (answers.some((answer) => !allowed.has(answer.questionId))) {
    throw new ApiError(400, 'One or more answers do not belong to this exam');
  }
  await prisma.$transaction(
    answers.map((answer) =>
      prisma.examAnswer.upsert({
        where: { attemptId_questionId: { attemptId, questionId: answer.questionId } },
        create: {
          attemptId,
          questionId: answer.questionId,
          selectedAnswer: answer.selectedAnswer as AnswerOption | null,
        },
        update: { selectedAnswer: answer.selectedAnswer as AnswerOption | null },
      }),
    ),
  );
  return attempt;
}

async function finalizeAttempt(attemptId: string, userId: string, forceAuto = false) {
  let attempt = await prisma.examAttempt.findFirst({
    where: { id: attemptId, userId },
    include: attemptInclude,
  });
  if (!attempt) throw new ApiError(404, 'Exam attempt not found');
  if (attempt.status === 'IN_PROGRESS') {
    const now = new Date();
    const autoSubmitted = forceAuto || now >= attempt.deadlineAt;
    const score = calculateExamScore(attempt.exam.questions, attempt.answers);
    const claimed = await prisma.examAttempt.updateMany({
      where: { id: attempt.id, userId, status: 'IN_PROGRESS' },
      data: {
        status: autoSubmitted ? 'AUTO_SUBMITTED' : 'SUBMITTED',
        submittedAt: now,
        scorePercent: score.scorePercent,
        correctCount: score.correctCount,
      },
    });
    if (claimed.count === 1) {
      await prisma.examParticipant.update({
        where: { examId_userId: { examId: attempt.examId, userId } },
        data: {
          score: score.scorePercent,
          timeTakenSeconds: Math.max(0, Math.min(
            Math.floor((now.getTime() - attempt.startedAt.getTime()) / 1000),
            attempt.exam.durationMinutes * 60,
          )),
          hasCompleted: true,
        },
      });
    }
  }

  const participants = await prisma.examParticipant.findMany({ where: { examId: attempt.examId } });
  const pendingInvitations = await prisma.examInvitation.count({
    where: { examId: attempt.examId, status: 'PENDING' },
  });
  const exam = await prisma.exam.findUniqueOrThrow({ where: { id: attempt.examId } });
  const now = new Date();
  const allDone = participants.length > 0 &&
    pendingInvitations === 0 &&
    participants.every((participant) => participant.hasCompleted);
  if (allDone || (exam.closesAt && now >= exam.closesAt)) {
    await prisma.exam.update({ where: { id: exam.id }, data: { status: 'COMPLETED' } });
  }

  attempt = await prisma.examAttempt.findUniqueOrThrow({
    where: { id: attempt.id },
    include: attemptInclude,
  });
  const currentStatus = effectiveExamStatus(
    attempt.exam.status,
    attempt.exam.startTime,
    attempt.exam.closesAt,
  );
  const releaseSolutions = canReleaseSolutions({
    examType: attempt.exam.type,
    releasePolicy: attempt.exam.resultRelease,
    examStatus: currentStatus,
    attemptSubmitted: attempt.status !== 'IN_PROGRESS',
  });
  const participantsWithUsers = await prisma.examParticipant.findMany({
    where: { examId: attempt.examId },
    include: { user: true },
  });
  const summarySource = {
    ...attempt.exam,
    status: currentStatus,
    participants: participantsWithUsers,
    invitations: attempt.exam.invitations,
    attempts: [attempt],
    _count: { questions: attempt.exam.questions.length },
  };
  return {
    exam: examSummary(summarySource, userId, releaseSolutions),
    attempt: attemptDto(attempt, releaseSolutions),
    solutionsReleased: releaseSolutions,
  };
}

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const userId = req.userId!;
    const tab = (req.query.tab as string | undefined) ?? 'mine';
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 20));
    const where: Prisma.ExamWhereInput = tab === 'invited'
      ? {
          organizerId: { not: userId },
          OR: [
            { participants: { some: { userId } } },
            { invitations: { some: { userId, status: { in: ['PENDING', 'ACCEPTED'] } } } },
          ],
        }
      : { organizerId: userId };
    const [items, total] = await prisma.$transaction([
      prisma.exam.findMany({
        where,
        include: summaryInclude,
        orderBy: [{ startTime: 'desc' }, { createdAt: 'desc' }],
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.exam.count({ where }),
    ]);
    res.json({
      exams: items.map((exam) => examSummary(exam, userId)),
      page,
      hasMore: page * limit < total,
      total,
    });
  }),
);

router.get(
  '/:id/results',
  asyncHandler(async (req, res) => {
    await accessibleExam(req.params.id, req.userId!);
    const attempt = await prisma.examAttempt.findUnique({
      where: { examId_userId: { examId: req.params.id, userId: req.userId! } },
    });
    if (!attempt) throw new ApiError(409, 'Start the exam before viewing results');
    if (attempt.status === 'IN_PROGRESS' && new Date() < attempt.deadlineAt) {
      throw new ApiError(409, 'Submit the exam before viewing results');
    }
    const result = await finalizeAttempt(attempt.id, req.userId!, new Date() >= attempt.deadlineAt);
    res.json(result);
  }),
);

router.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const exam = await accessibleExam(req.params.id, req.userId!);
    res.json({ exam: examSummary(exam, req.userId!) });
  }),
);

router.post(
  '/',
  asyncHandler(async (req, res) => {
    const organizerId = req.userId!;
    const body = examInputSchema.parse(req.body);
    await assertOwnedHierarchy(organizerId, body.subjectId, body.topicId);
    const exam = await prisma.exam.create({
      data: {
        title: body.title,
        subjectId: body.subjectId,
        topicId: body.topicId,
        type: examTypeToDb(body.type),
        status: 'DRAFT',
        durationMinutes: body.durationMinutes,
        startTime: body.startTime ? new Date(body.startTime) : null,
        questionCount: body.questionCount,
        passPercent: body.passPercent,
        shuffleQuestions: body.shuffleQuestions,
        organizerId,
        participants: { create: { userId: organizerId } },
      },
      include: summaryInclude,
    });
    const result = body.publish
      ? await publishExam(exam.id, organizerId, body.participantIds)
      : exam;
    res.status(201).json({ exam: examSummary(result, organizerId) });
  }),
);

router.patch(
  '/:id',
  asyncHandler(async (req, res) => {
    const organizerId = req.userId!;
    const body = examInputSchema.partial().omit({ publish: true, participantIds: true }).parse(req.body);
    const exam = await prisma.exam.findUnique({ where: { id: req.params.id } });
    if (!exam) throw new ApiError(404, 'Exam not found');
    if (exam.organizerId !== organizerId) throw new ApiError(403, 'Only the organizer can edit this exam');
    if (exam.status !== 'DRAFT') throw new ApiError(409, 'Published exams cannot be edited');
    if (body.subjectId || body.topicId) {
      await assertOwnedHierarchy(
        organizerId,
        body.subjectId ?? exam.subjectId,
        body.topicId ?? exam.topicId,
      );
    }
    const updated = await prisma.exam.update({
      where: { id: exam.id },
      data: {
        ...body,
        type: body.type ? examTypeToDb(body.type) : undefined,
        startTime: body.startTime === undefined
          ? undefined
          : body.startTime
            ? new Date(body.startTime)
            : null,
      },
      include: summaryInclude,
    });
    res.json({ exam: examSummary(updated, organizerId) });
  }),
);

router.post(
  '/:id/publish',
  asyncHandler(async (req, res) => {
    const body = z.object({ participantIds: z.array(z.string().uuid()).max(50).default([]) }).parse(req.body);
    const exam = await publishExam(req.params.id, req.userId!, body.participantIds);
    res.json({ exam: examSummary(exam, req.userId!) });
  }),
);

router.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const exam = await prisma.exam.findUnique({ where: { id: req.params.id } });
    if (!exam) throw new ApiError(404, 'Exam not found');
    if (exam.organizerId !== req.userId) throw new ApiError(403, 'Only the organizer can delete this exam');
    if (exam.status !== 'DRAFT') throw new ApiError(409, 'Only draft exams can be deleted');
    await prisma.exam.delete({ where: { id: exam.id } });
    res.status(204).send();
  }),
);

router.post(
  '/:id/invitations/respond',
  asyncHandler(async (req, res) => {
    const userId = req.userId!;
    const { response } = z.object({ response: z.enum(['accepted', 'declined']) }).parse(req.body);
    const invitation = await prisma.examInvitation.findUnique({
      where: { examId_userId: { examId: req.params.id, userId } },
      include: { exam: true },
    });
    if (!invitation) throw new ApiError(404, 'Exam invitation not found');
    if (invitation.status !== 'PENDING') throw new ApiError(409, 'This invitation was already answered');
    if (['COMPLETED', 'CANCELLED'].includes(invitation.exam.status)) {
      throw new ApiError(409, 'This exam is no longer accepting participants');
    }
    await prisma.$transaction(async (tx) => {
      await tx.examInvitation.update({
        where: { id: invitation.id },
        data: {
          status: response === 'accepted' ? 'ACCEPTED' : 'DECLINED',
          respondedAt: new Date(),
        },
      });
      if (response === 'accepted') {
        await tx.examParticipant.upsert({
          where: { examId_userId: { examId: invitation.examId, userId } },
          create: { examId: invitation.examId, userId },
          update: {},
        });
      }
    });
    const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    await notifyMany([invitation.exam.organizerId], {
      title: `Exam invitation ${response}`,
      message: `${user.fullName} ${response} “${invitation.exam.title}”.`,
      relatedId: invitation.examId,
    });
    emitExamChanged([userId, invitation.exam.organizerId], {
      examId: invitation.examId,
      action: response,
    });
    res.json({ success: true, status: response });
  }),
);

router.post(
  '/:id/attempts',
  asyncHandler(async (req, res) => {
    const attempt = await startOrResumeAttempt(req.params.id, req.userId!);
    if (attempt.status === 'IN_PROGRESS' && new Date() >= attempt.deadlineAt) {
      const result = await finalizeAttempt(attempt.id, req.userId!, true);
      res.json({ ...result, serverNow: new Date() });
      return;
    }
    res.status(201).json({
      exam: examSummary({
        ...attempt.exam,
        attempts: [attempt],
        _count: { questions: attempt.exam.questions.length },
      }, req.userId!),
      attempt: attemptDto(attempt),
      serverNow: new Date(),
    });
  }),
);

router.put(
  '/:id/attempts/:attemptId/answers',
  asyncHandler(async (req, res) => {
    const { answers } = z.object({ answers: z.array(answerSchema).max(50) }).parse(req.body);
    const attempt = await persistAnswers(req.params.attemptId, req.userId!, answers);
    if (attempt.status === 'IN_PROGRESS' && new Date() >= attempt.deadlineAt) {
      const result = await finalizeAttempt(attempt.id, req.userId!, true);
      res.status(409).json({ error: 'Time expired; the exam was submitted automatically', ...result });
      return;
    }
    res.json({ success: true, savedAt: new Date() });
  }),
);

router.post(
  '/:id/attempts/:attemptId/submit',
  asyncHandler(async (req, res) => {
    const { answers } = z.object({ answers: z.array(answerSchema).max(50).default([]) }).parse(req.body);
    if (answers.length > 0) {
      await persistAnswers(req.params.attemptId, req.userId!, answers);
    }
    const result = await finalizeAttempt(req.params.attemptId, req.userId!);
    const organizerId = result.exam.organizerId as string;
    if (organizerId !== req.userId) {
      const user = await prisma.user.findUniqueOrThrow({ where: { id: req.userId! } });
      await notifyMany([organizerId], {
        title: 'Exam submitted',
        message: `${user.fullName} submitted “${result.exam.title}”.`,
        relatedId: req.params.id,
      });
    }
    emitExamChanged(
      result.exam.participants.map((participant: any) => participant.userId),
      { examId: req.params.id, action: 'submitted' },
    );
    res.json(result);
  }),
);

router.post(
  '/:id/cancel',
  asyncHandler(async (req, res) => {
    const exam = await prisma.exam.findUnique({
      where: { id: req.params.id },
      include: { participants: true, invitations: true },
    });
    if (!exam) throw new ApiError(404, 'Exam not found');
    if (exam.organizerId !== req.userId) throw new ApiError(403, 'Only the organizer can cancel this exam');
    if (['COMPLETED', 'CANCELLED'].includes(exam.status)) throw new ApiError(409, 'This exam cannot be cancelled');
    await prisma.exam.update({ where: { id: exam.id }, data: { status: 'CANCELLED' } });
    const recipients = [
      ...exam.participants.map((participant) => participant.userId),
      ...exam.invitations.map((invitation) => invitation.userId),
    ].filter((userId) => userId !== req.userId);
    await notifyMany(recipients, {
      title: 'Exam cancelled',
      message: `“${exam.title}” was cancelled by the organizer.`,
      relatedId: exam.id,
    });
    emitExamChanged(recipients, { examId: exam.id, action: 'cancelled' });
    res.json({ success: true });
  }),
);

// Compatibility endpoint for older app builds. It creates/resumes the secure
// server attempt instead of changing status based on client state.
router.post(
  '/:id/start',
  asyncHandler(async (req, res) => {
    const attempt = await startOrResumeAttempt(req.params.id, req.userId!);
    res.json({ attempt: attemptDto(attempt), serverNow: new Date() });
  }),
);

export default router;
