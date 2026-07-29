import { Router } from 'express';
import { prisma } from '../lib/prisma';
import { requireAuth } from '../middleware/auth.middleware';
import { asyncHandler } from '../utils/asyncHandler';
import { toQuizAttemptDto, toQuizDto } from '../utils/serializers';
import { getUserStats } from '../utils/userStats';

const DAY_MS = 24 * 60 * 60 * 1000;
const REVISION_INTERVALS = [1, 3, 7, 14, 30] as const;

function average(values: number[]) {
  return values.length === 0
    ? 0
    : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function utcDayKey(value: Date) {
  return value.toISOString().slice(0, 10);
}

function utcDayStart(value: Date) {
  return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()));
}

function intervalStage(intervalDays: number) {
  if (intervalDays >= 30) return 5;
  if (intervalDays >= 14) return 4;
  if (intervalDays >= 7) return 3;
  if (intervalDays >= 3) return 2;
  return 1;
}

function calculateStreaks(activityDates: Date[], now: Date) {
  const days = Array.from(new Set(activityDates.map(utcDayKey))).sort();
  const daySet = new Set(days);
  let longestStreak = 0;
  let runningStreak = 0;
  let previousDay: number | null = null;

  for (const day of days) {
    const dayValue = new Date(`${day}T00:00:00.000Z`).getTime();
    runningStreak = previousDay !== null && dayValue - previousDay === DAY_MS
      ? runningStreak + 1
      : 1;
    longestStreak = Math.max(longestStreak, runningStreak);
    previousDay = dayValue;
  }

  const today = utcDayStart(now);
  const yesterday = new Date(today.getTime() - DAY_MS);
  let cursor = daySet.has(utcDayKey(today)) ? today : yesterday;
  let currentStreak = 0;
  while (daySet.has(utcDayKey(cursor))) {
    currentStreak++;
    cursor = new Date(cursor.getTime() - DAY_MS);
  }

  return { currentStreak, longestStreak };
}

const router = Router();
router.use(requireAuth);

router.get(
  '/home',
  asyncHandler(async (req, res) => {
    const userId = req.userId!;
    const stats = await getUserStats(userId);
    const now = new Date();
    const revisionHorizon = new Date(now.getTime() + 3 * DAY_MS);

    const [dueRepetitions, dueNow, upcoming, activePlans] = await Promise.all([
      prisma.spacedRepetition.findMany({
        where: { userId, nextRevisionDate: { lte: revisionHorizon } },
        orderBy: { nextRevisionDate: 'asc' },
        take: 5,
        include: { quiz: { include: { subject: true, topic: true, questions: true } } },
      }),
      prisma.spacedRepetition.count({
        where: { userId, nextRevisionDate: { lte: now } },
      }),
      prisma.spacedRepetition.count({
        where: { userId, nextRevisionDate: { gt: now, lte: revisionHorizon } },
      }),
      prisma.spacedRepetition.count({ where: { userId } }),
    ]);
    const dueForRevision = await Promise.all(
      dueRepetitions.map(async (revision) => {
        const extras = {
          attemptCount: await prisma.quizAttempt.count({
            where: { quizId: revision.quizId, userId },
          }),
          bestScore: revision.lastScore,
          avgScore: revision.lastScore,
          lastAttemptDate: null,
          nextRevisionDate: revision.nextRevisionDate,
          revisionIntervalDays: revision.intervalDays,
        };
        return toQuizDto(revision.quiz, extras);
      })
    );

    const recentAttempts = await prisma.quizAttempt.findMany({
      where: { userId },
      orderBy: { attemptedAt: 'desc' },
      take: 5,
      include: {
        quiz: { include: { subject: true, topic: true } },
        session: true,
      },
    });

    const lastAttempt = await prisma.quizAttempt.findFirst({
      where: { userId },
      orderBy: { attemptedAt: 'desc' },
      include: { quiz: { include: { subject: true, topic: true } } },
    });
    const lastSubject = lastAttempt?.quiz.subject ?? (await prisma.subject.findFirst({
      where: { ownerId: userId },
      orderBy: { updatedAt: 'desc' },
    }));
    const lastTopic = lastAttempt?.quiz.topic ?? (await prisma.topic.findFirst({
      where: { subject: { ownerId: userId } },
      orderBy: { createdAt: 'desc' },
    }));

    res.json({
      stats: {
        totalSubjects: stats.subjectCount,
        totalQuizzes: stats.quizCount,
        avgScore: stats.avgScore,
        friendCount: stats.friendCount,
      },
      revisionSummary: { dueNow, upcoming, activePlans },
      dueForRevision,
      recentActivity: recentAttempts.map(toQuizAttemptDto),
      lastSubject: lastSubject ? { id: lastSubject.id, name: lastSubject.name } : null,
      lastTopic: lastTopic
        ? { id: lastTopic.id, name: lastTopic.name, subjectId: lastTopic.subjectId }
        : null,
    });
  })
);

router.get(
  '/performance',
  asyncHandler(async (req, res) => {
    const userId = req.userId!;
    const requestedPeriod = req.query.period as string | undefined;
    const period = requestedPeriod === 'week' || requestedPeriod === 'month'
      ? requestedPeriod
      : 'all';
    const now = new Date();
    const periodDays = period === 'week' ? 7 : period === 'month' ? 30 : null;
    const since = periodDays === null
      ? new Date(0)
      : new Date(now.getTime() - periodDays * DAY_MS);
    const previousSince = periodDays === null
      ? null
      : new Date(since.getTime() - periodDays * DAY_MS);
    const activitySince = new Date(utcDayStart(now).getTime() - 364 * DAY_MS);

    const previousQuizPromise = previousSince
      ? prisma.quizAttempt.findMany({
          where: { userId, attemptedAt: { gte: previousSince, lt: since } },
          select: { scorePercent: true },
        })
      : Promise.resolve([]);
    const previousExamPromise = previousSince
      ? prisma.examAttempt.findMany({
          where: {
            userId,
            status: { in: ['SUBMITTED', 'AUTO_SUBMITTED'] },
            submittedAt: { gte: previousSince, lt: since },
          },
          select: { scorePercent: true },
        })
      : Promise.resolve([]);

    const [
      quizAttempts,
      examAttempts,
      revisionRows,
      activityQuizAttempts,
      activityExamAttempts,
      previousQuizAttempts,
      previousExamAttempts,
    ] = await Promise.all([
      prisma.quizAttempt.findMany({
        where: { userId, attemptedAt: { gte: since, lte: now } },
        include: { quiz: { include: { subject: true, topic: true } } },
        orderBy: { attemptedAt: 'asc' },
      }),
      prisma.examAttempt.findMany({
        where: {
          userId,
          status: { in: ['SUBMITTED', 'AUTO_SUBMITTED'] },
          submittedAt: { gte: since, lte: now },
        },
        include: { exam: { include: { subject: true, topic: true } } },
        orderBy: { submittedAt: 'desc' },
      }),
      prisma.spacedRepetition.findMany({
        where: { userId },
        orderBy: { nextRevisionDate: 'asc' },
        include: {
          quiz: {
            select: {
              id: true,
              title: true,
              subject: { select: { id: true, name: true } },
              topic: { select: { id: true, name: true } },
            },
          },
        },
      }),
      prisma.quizAttempt.findMany({
        where: { userId, attemptedAt: { gte: activitySince, lte: now } },
        select: { attemptedAt: true },
      }),
      prisma.examAttempt.findMany({
        where: {
          userId,
          status: { in: ['SUBMITTED', 'AUTO_SUBMITTED'] },
          submittedAt: { gte: activitySince, lte: now },
        },
        select: { submittedAt: true },
      }),
      previousQuizPromise,
      previousExamPromise,
    ]);

    const quizScores = quizAttempts.map((attempt) => attempt.scorePercent);
    const examScores = examAttempts.map((attempt) => attempt.scorePercent ?? 0);
    const allScores = [...quizScores, ...examScores];
    const previousScores = [
      ...previousQuizAttempts.map((attempt) => attempt.scorePercent),
      ...previousExamAttempts.map((attempt) => attempt.scorePercent ?? 0),
    ];
    const quizPasses = quizAttempts.filter((attempt) => attempt.scorePercent >= 60).length;
    const examPasses = examAttempts.filter(
      (attempt) => (attempt.scorePercent ?? 0) >= attempt.exam.passPercent
    ).length;
    const totalCompleted = allScores.length;
    const totalStudySeconds = quizAttempts.reduce(
      (sum, attempt) => sum + (attempt.timeTakenSeconds ?? 0),
      0
    ) + examAttempts.reduce((sum, attempt) => {
      if (!attempt.submittedAt) return sum;
      return sum + Math.max(
        0,
        Math.floor((attempt.submittedAt.getTime() - attempt.startedAt.getTime()) / 1000)
      );
    }, 0);

    type BreakdownBucket = {
      id: string;
      name: string;
      subjectId?: string;
      scores: number[];
    };
    const subjects = new Map<string, BreakdownBucket>();
    const topics = new Map<string, BreakdownBucket>();
    const scoresByDay = new Map<string, number[]>();

    for (const attempt of quizAttempts) {
      const subject = attempt.quiz.subject;
      const topic = attempt.quiz.topic;
      const subjectBucket = subjects.get(subject.id) ?? {
        id: subject.id,
        name: subject.name,
        scores: [],
      };
      subjectBucket.scores.push(attempt.scorePercent);
      subjects.set(subject.id, subjectBucket);

      const topicBucket = topics.get(topic.id) ?? {
        id: topic.id,
        name: topic.name,
        subjectId: subject.id,
        scores: [],
      };
      topicBucket.scores.push(attempt.scorePercent);
      topics.set(topic.id, topicBucket);

      const date = utcDayKey(attempt.attemptedAt);
      scoresByDay.set(date, [...(scoresByDay.get(date) ?? []), attempt.scorePercent]);
    }

    const toBreakdown = (bucket: BreakdownBucket) => ({
      id: bucket.id,
      name: bucket.name,
      subjectId: bucket.subjectId ?? null,
      averageScore: average(bucket.scores),
      attemptCount: bucket.scores.length,
    });
    const subjectPerformance = Array.from(subjects.values())
      .map(toBreakdown)
      .sort((a, b) => b.averageScore - a.averageScore);
    const topicPerformance = Array.from(topics.values())
      .map(toBreakdown)
      .sort((a, b) => b.averageScore - a.averageScore);
    const bestSubject = subjectPerformance[0] ?? null;
    const weakestSubject = subjectPerformance.length > 0
      ? subjectPerformance.reduce((weakest, item) =>
          item.averageScore < weakest.averageScore ? item : weakest
        )
      : null;
    const scoreTrend = Array.from(scoresByDay.entries())
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([date, scores]) => ({
        date,
        score: average(scores),
        attemptCount: scores.length,
      }));

    const activityDates = [
      ...activityQuizAttempts.map((attempt) => attempt.attemptedAt),
      ...activityExamAttempts
        .map((attempt) => attempt.submittedAt)
        .filter((date): date is Date => date !== null),
    ];
    const { currentStreak, longestStreak } = calculateStreaks(activityDates, now);
    const activityCounts = new Map<string, number>();
    for (const date of activityDates) {
      const key = utcDayKey(date);
      activityCounts.set(key, (activityCounts.get(key) ?? 0) + 1);
    }
    const dailyActivity = Array.from({ length: 7 }, (_, index) => {
      const date = new Date(utcDayStart(now).getTime() - (6 - index) * DAY_MS);
      const key = utcDayKey(date);
      return { date: key, count: activityCounts.get(key) ?? 0 };
    });

    const startToday = utcDayStart(now);
    const upcomingHorizon = new Date(now.getTime() + 7 * DAY_MS);
    const dueNow = revisionRows.filter(
      (revision) => revision.nextRevisionDate >= startToday && revision.nextRevisionDate <= now
    ).length;
    const overdue = revisionRows.filter(
      (revision) => revision.nextRevisionDate < startToday
    ).length;
    const upcoming = revisionRows.filter(
      (revision) => revision.nextRevisionDate > now && revision.nextRevisionDate <= upcomingHorizon
    ).length;
    const revisionStages = REVISION_INTERVALS.map((intervalDays, index) => ({
      stage: index + 1,
      intervalDays,
      count: revisionRows.filter(
        (revision) => intervalStage(revision.intervalDays) === index + 1
      ).length,
    }));
    const revisionQueue = revisionRows.slice(0, 10).map((revision) => ({
      quizId: revision.quiz.id,
      quizTitle: revision.quiz.title,
      subjectId: revision.quiz.subject.id,
      subjectName: revision.quiz.subject.name,
      topicId: revision.quiz.topic.id,
      topicName: revision.quiz.topic.name,
      nextRevisionDate: revision.nextRevisionDate,
      lastScore: revision.lastScore,
      intervalDays: revision.intervalDays,
      stage: intervalStage(revision.intervalDays),
    }));

    const insights: Array<{
      type: string;
      message: string;
      subjectId?: string;
      quizId?: string;
    }> = [];
    if (bestSubject) {
      insights.push({
        type: 'strength',
        message: `${bestSubject.name} is your strongest subject at ${bestSubject.averageScore.toFixed(0)}%.`,
        subjectId: bestSubject.id,
      });
    }
    if (weakestSubject && weakestSubject.id !== bestSubject?.id) {
      insights.push({
        type: 'focus',
        message: `A focused session in ${weakestSubject.name} could lift your ${weakestSubject.averageScore.toFixed(0)}% average.`,
        subjectId: weakestSubject.id,
      });
    }
    if (overdue > 0) {
      insights.push({
        type: 'revision',
        message: `${overdue} review${overdue === 1 ? '' : 's'} are overdue. Clear the oldest one first.`,
        quizId: revisionQueue[0]?.quizId,
      });
    }

    const recommendation = revisionQueue.length > 0 && overdue + dueNow > 0
      ? {
          title: `Review ${revisionQueue[0].quizTitle}`,
          message: 'This is the highest-priority item in your memory plan.',
          actionType: 'review',
          relatedId: revisionQueue[0].quizId,
        }
      : weakestSubject
        ? {
            title: `Strengthen ${weakestSubject.name}`,
            message: 'Practice the subject with your lowest current quiz average.',
            actionType: 'subject',
            relatedId: weakestSubject.id,
          }
        : {
            title: 'Build your first performance signal',
            message: 'Complete a quiz to unlock personalized guidance.',
            actionType: 'quizzes',
            relatedId: null,
          };

    const subjectScores = Object.fromEntries(
      subjectPerformance.map((item) => [item.name, item.averageScore])
    );
    const topicAccuracies = Object.fromEntries(
      topicPerformance.map((item) => [item.name, item.averageScore])
    );
    const overallScore = average(allScores);
    const previousOverallScore = average(previousScores);

    res.json({
      period,
      summary: {
        totalQuizzesAttempted: quizAttempts.length,
        totalExamsCompleted: examAttempts.length,
        totalCompleted,
        avgQuizScore: average(quizScores),
        avgExamScore: average(examScores),
        overallScore,
        scoreChange: periodDays !== null && previousScores.length > 0
          ? overallScore - previousOverallScore
          : null,
        passRate: totalCompleted === 0
          ? 0
          : ((quizPasses + examPasses) / totalCompleted) * 100,
        studyMinutes: Math.round(totalStudySeconds / 60),
        bestSubject: bestSubject?.name ?? null,
        weakestSubject: weakestSubject?.name ?? null,
      },
      consistency: {
        currentStreak,
        longestStreak,
        activeDaysLast7: dailyActivity.filter((day) => day.count > 0).length,
        dailyActivity,
      },
      memory: {
        dueNow,
        overdue,
        upcoming,
        activePlans: revisionRows.length,
        stages: revisionStages,
      },
      scoreTrend,
      subjectPerformance,
      topicPerformance,
      revisionQueue,
      insights,
      recommendation,
      recentExamHistory: examAttempts.slice(0, 10).map((attempt) => ({
        examId: attempt.exam.id,
        examTitle: attempt.exam.title,
        subjectId: attempt.exam.subject.id,
        subjectName: attempt.exam.subject.name,
        score: attempt.scorePercent ?? 0,
        passPercent: attempt.exam.passPercent,
        passed: (attempt.scorePercent ?? 0) >= attempt.exam.passPercent,
        timeTakenSeconds: attempt.submittedAt
          ? Math.max(
              0,
              Math.floor((attempt.submittedAt.getTime() - attempt.startedAt.getTime()) / 1000)
            )
          : null,
        submittedAt: attempt.submittedAt,
      })),
      // Compatibility fields for older clients.
      subjectScores,
      topicAccuracies,
      weeklyActivity: dailyActivity.map((day) => day.count),
      upcomingRevisions: revisionQueue,
    });
  })
);

export default router;
