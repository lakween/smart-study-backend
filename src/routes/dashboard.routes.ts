import { Router } from 'express';
import { prisma } from '../lib/prisma';
import { requireAuth } from '../middleware/auth.middleware';
import { asyncHandler } from '../utils/asyncHandler';
import { toQuizAttemptDto, toQuizDto } from '../utils/serializers';
import { getUserStats } from '../utils/userStats';

const router = Router();
router.use(requireAuth);

router.get(
  '/home',
  asyncHandler(async (req, res) => {
    const userId = req.userId!;
    const stats = await getUserStats(userId);

    const dueRepetitions = await prisma.spacedRepetition.findMany({
      where: { userId, nextRevisionDate: { lte: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000) } },
      orderBy: { nextRevisionDate: 'asc' },
      take: 5,
      include: { quiz: { include: { subject: true, topic: true, questions: true } } },
    });
    const dueForRevision = await Promise.all(
      dueRepetitions.map(async (r) => {
        const extras = {
          attemptCount: await prisma.quizAttempt.count({ where: { quizId: r.quizId, userId } }),
          bestScore: r.lastScore,
          avgScore: r.lastScore,
          lastAttemptDate: null,
          nextRevisionDate: r.nextRevisionDate,
        };
        return toQuizDto(r.quiz, extras);
      })
    );

    const recentAttempts = await prisma.quizAttempt.findMany({
      where: { userId },
      orderBy: { attemptedAt: 'desc' },
      take: 5,
      include: { quiz: true },
    });

    const lastAttempt = await prisma.quizAttempt.findFirst({
      where: { userId },
      orderBy: { attemptedAt: 'desc' },
      include: { quiz: { include: { subject: true, topic: true } } },
    });
    const lastSubject = lastAttempt?.quiz.subject ?? (await prisma.subject.findFirst({ where: { ownerId: userId }, orderBy: { updatedAt: 'desc' } }));
    const lastTopic = lastAttempt?.quiz.topic ?? (await prisma.topic.findFirst({ where: { subject: { ownerId: userId } }, orderBy: { createdAt: 'desc' } }));

    res.json({
      stats: {
        totalSubjects: stats.subjectCount,
        totalQuizzes: stats.quizCount,
        avgScore: stats.avgScore,
        friendCount: stats.friendCount,
      },
      dueForRevision,
      recentActivity: recentAttempts.map(toQuizAttemptDto),
      lastSubject: lastSubject ? { id: lastSubject.id, name: lastSubject.name } : null,
      lastTopic: lastTopic ? { id: lastTopic.id, name: lastTopic.name, subjectId: lastTopic.subjectId } : null,
    });
  })
);

router.get(
  '/performance',
  asyncHandler(async (req, res) => {
    const userId = req.userId!;
    const period = (req.query.period as string | undefined) ?? 'all';

    const since =
      period === 'week'
        ? new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
        : period === 'month'
          ? new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
          : new Date(0);

    const [quizAttempts, examParticipations] = await Promise.all([
      prisma.quizAttempt.findMany({
        where: { userId, attemptedAt: { gte: since } },
        include: { quiz: { include: { subject: true, topic: true } } },
        orderBy: { attemptedAt: 'asc' },
      }),
      prisma.examParticipant.findMany({
        where: { userId, hasCompleted: true, exam: { createdAt: { gte: since } } },
        include: { exam: { include: { subject: true, topic: true } } },
      }),
    ]);

    const totalQuizzesAttempted = quizAttempts.length;
    const totalExamsCompleted = examParticipations.length;
    const avgQuizScore = totalQuizzesAttempted === 0 ? 0 : quizAttempts.reduce((s, a) => s + a.scorePercent, 0) / totalQuizzesAttempted;
    const avgExamScore =
      totalExamsCompleted === 0 ? 0 : examParticipations.reduce((s, p) => s + (p.score ?? 0), 0) / totalExamsCompleted;

    const scoresBySubject = new Map<string, number[]>();
    const scoresByTopic = new Map<string, number[]>();
    const scoresByDay = new Map<string, number[]>();
    const attemptsByWeekday = [0, 0, 0, 0, 0, 0, 0];

    for (const a of quizAttempts) {
      const subjectName = a.quiz.subject.name;
      const topicName = a.quiz.topic.name;
      const dayKey = a.attemptedAt.toISOString().slice(0, 10);

      scoresBySubject.set(subjectName, [...(scoresBySubject.get(subjectName) ?? []), a.scorePercent]);
      scoresByTopic.set(topicName, [...(scoresByTopic.get(topicName) ?? []), a.scorePercent]);
      scoresByDay.set(dayKey, [...(scoresByDay.get(dayKey) ?? []), a.scorePercent]);
      // Monday-first index (0=Mon..6=Sun) to match the app's weekly-activity chart labels.
      attemptsByWeekday[(a.attemptedAt.getDay() + 6) % 7]++;
    }

    const avg = (arr: number[]) => arr.reduce((s, v) => s + v, 0) / arr.length;
    const subjectScores = Object.fromEntries(Array.from(scoresBySubject.entries()).map(([k, v]) => [k, avg(v)]));
    const topicAccuracies = Object.fromEntries(Array.from(scoresByTopic.entries()).map(([k, v]) => [k, avg(v)]));
    const scoreTrend = Array.from(scoresByDay.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, scores]) => ({ date, score: avg(scores) }));

    const subjectEntries = Object.entries(subjectScores);
    const bestSubject = subjectEntries.length ? subjectEntries.reduce((a, b) => (b[1] > a[1] ? b : a))[0] : null;
    const weakestSubject = subjectEntries.length ? subjectEntries.reduce((a, b) => (b[1] < a[1] ? b : a))[0] : null;

    const upcomingRevisions = await prisma.spacedRepetition.findMany({
      where: { userId, nextRevisionDate: { gte: new Date() } },
      orderBy: { nextRevisionDate: 'asc' },
      take: 10,
      include: { quiz: { select: { id: true, title: true } }, topic: { select: { name: true } } },
    });

    const insights: Array<{ icon: string; message: string }> = [];
    if (bestSubject) insights.push({ icon: '📈', message: `You're performing best in ${bestSubject} — keep it up!` });
    if (weakestSubject && weakestSubject !== bestSubject) {
      insights.push({ icon: '⚠️', message: `You need more practice in ${weakestSubject}.` });
    }
    const missedRevisions = await prisma.spacedRepetition.count({
      where: { userId, nextRevisionDate: { lt: new Date(Date.now() - 24 * 60 * 60 * 1000) } },
    });
    if (missedRevisions > 0) insights.push({ icon: '🔔', message: `You missed ${missedRevisions} revision reminder${missedRevisions === 1 ? '' : 's'}.` });

    res.json({
      summary: {
        totalQuizzesAttempted,
        totalExamsCompleted,
        avgQuizScore,
        avgExamScore,
        bestSubject,
        weakestSubject,
      },
      scoreTrend,
      subjectScores,
      topicAccuracies,
      weeklyActivity: attemptsByWeekday,
      upcomingRevisions: upcomingRevisions.map((r) => ({
        quizId: r.quiz.id,
        quizTitle: r.quiz.title,
        topicName: r.topic.name,
        nextRevisionDate: r.nextRevisionDate,
        lastScore: r.lastScore,
      })),
      insights,
      recentExamHistory: examParticipations.slice(-10).map((p) => ({
        examId: p.exam.id,
        examTitle: p.exam.title,
        subjectName: p.exam.subject.name,
        score: p.score,
        timeTakenSeconds: p.timeTakenSeconds,
      })),
    });
  })
);

export default router;
