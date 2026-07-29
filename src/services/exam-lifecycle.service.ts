import { prisma } from '../lib/prisma';
import { emitExamChanged, emitNotification } from '../realtime/socket';
import { toNotificationDto } from '../utils/serializers';
import { calculateExamScore } from './exam.service';

const DEFAULT_SCAN_INTERVAL_MS = 30_000;

let timer: ReturnType<typeof setInterval> | null = null;
let scanInProgress = false;

export async function runExamLifecycleScan(now = new Date()): Promise<{
  attemptsSubmitted: number;
  examsCompleted: number;
}> {
  if (scanInProgress) return { attemptsSubmitted: 0, examsCompleted: 0 };
  scanInProgress = true;

  try {
    await prisma.exam.updateMany({
      where: { status: 'SCHEDULED', startTime: { lte: now } },
      data: { status: 'STARTED' },
    });

    const overdueAttempts = await prisma.examAttempt.findMany({
      where: { status: 'IN_PROGRESS', deadlineAt: { lte: now } },
      include: {
        answers: true,
        user: { select: { fullName: true } },
        exam: {
          include: { questions: true },
        },
      },
    });

    let attemptsSubmitted = 0;
    for (const attempt of overdueAttempts) {
      const score = calculateExamScore(attempt.exam.questions, attempt.answers);
      const notification = await prisma.$transaction(async (tx) => {
        const claimed = await tx.examAttempt.updateMany({
          where: { id: attempt.id, status: 'IN_PROGRESS' },
          data: {
            status: 'AUTO_SUBMITTED',
            submittedAt: now,
            scorePercent: score.scorePercent,
            correctCount: score.correctCount,
          },
        });
        if (claimed.count === 0) return null;

        await tx.examParticipant.update({
          where: {
            examId_userId: {
              examId: attempt.examId,
              userId: attempt.userId,
            },
          },
          data: {
            score: score.scorePercent,
            timeTakenSeconds: Math.max(
              0,
              Math.min(
                Math.floor(
                  (attempt.deadlineAt.getTime() - attempt.startedAt.getTime()) /
                    1000,
                ),
                attempt.exam.durationMinutes * 60,
              ),
            ),
            hasCompleted: true,
          },
        });

        return tx.notification.create({
          data: {
            userId: attempt.userId,
            type: 'EXAM',
            title: 'Exam auto-submitted',
            message: `Your time for “${attempt.exam.title}” ended, so your saved answers were submitted.`,
            relatedId: attempt.examId,
          },
        });
      });

      if (notification) {
        attemptsSubmitted++;
        emitNotification(attempt.userId, toNotificationDto(notification));
        emitExamChanged(
          [attempt.userId, attempt.exam.organizerId],
          { examId: attempt.examId, action: 'autoSubmitted' },
        );
      }
    }

    await prisma.examInvitation.updateMany({
      where: {
        status: 'PENDING',
        exam: { closesAt: { lte: now } },
      },
      data: { status: 'EXPIRED', respondedAt: now },
    });

    const examsToClose = await prisma.exam.findMany({
      where: {
        status: { in: ['SCHEDULED', 'STARTED'] },
        closesAt: { lte: now },
      },
      include: { participants: true, invitations: true },
    });

    let examsCompleted = 0;
    for (const exam of examsToClose) {
      const recipients = [
        exam.organizerId,
        ...exam.participants.map((participant) => participant.userId),
        ...exam.invitations.map((invitation) => invitation.userId),
      ].filter((userId, index, all) => all.indexOf(userId) === index);

      const notifications = await prisma.$transaction(async (tx) => {
        const claimed = await tx.exam.updateMany({
          where: {
            id: exam.id,
            status: { in: ['SCHEDULED', 'STARTED'] },
          },
          data: { status: 'COMPLETED' },
        });
        if (claimed.count === 0) return [];
        return Promise.all(
          recipients.map((userId) =>
            tx.notification.create({
              data: {
                userId,
                type: 'EXAM',
                title: 'Exam results available',
                message: `“${exam.title}” has closed. Results are now available.`,
                relatedId: exam.id,
              },
            }),
          ),
        );
      });

      if (notifications.length > 0) {
        examsCompleted++;
        notifications.forEach((notification) => {
          emitNotification(notification.userId, toNotificationDto(notification));
        });
        emitExamChanged(recipients, { examId: exam.id, action: 'completed' });
      }
    }

    return { attemptsSubmitted, examsCompleted };
  } finally {
    scanInProgress = false;
  }
}

export function startExamLifecycleScheduler(
  intervalMs = DEFAULT_SCAN_INTERVAL_MS,
): void {
  if (timer) return;

  const scan = () => {
    void runExamLifecycleScan().catch((error: unknown) => {
      console.error('Exam lifecycle scan failed', error);
    });
  };

  scan();
  timer = setInterval(scan, intervalMs);
  timer.unref();
}

export function stopExamLifecycleScheduler(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}
