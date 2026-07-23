import { prisma } from '../lib/prisma';

export async function getUserStats(userId: string) {
  const [subjectCount, quizCount, friendCount, attempts] = await Promise.all([
    prisma.subject.count({ where: { ownerId: userId } }),
    prisma.quiz.count({ where: { ownerId: userId } }),
    prisma.friendship.count({
      where: { status: 'ACCEPTED', OR: [{ requesterId: userId }, { addresseeId: userId }] },
    }),
    prisma.quizAttempt.findMany({ where: { userId }, select: { scorePercent: true } }),
  ]);

  const quizzesAttempted = attempts.length;
  const avgScore = quizzesAttempted === 0 ? 0 : attempts.reduce((sum, a) => sum + a.scorePercent, 0) / quizzesAttempted;

  return { subjectCount, quizCount, friendCount, quizzesAttempted, avgScore };
}
