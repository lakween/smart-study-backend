import { prisma } from '../lib/prisma';
import { emitNotification } from '../realtime/socket';
import { toNotificationDto } from '../utils/serializers';

const DEFAULT_SCAN_INTERVAL_MS = 15 * 60 * 1000;

let timer: ReturnType<typeof setInterval> | null = null;
let scanInProgress = false;

export async function runRevisionReminderScan(now = new Date()): Promise<number> {
  if (scanInProgress) return 0;
  scanInProgress = true;

  try {
    const dueRevisions = await prisma.spacedRepetition.findMany({
      where: { nextRevisionDate: { lte: now } },
      include: { quiz: { select: { title: true } } },
    });

    let createdCount = 0;
    for (const revision of dueRevisions) {
      if (
        revision.reminderRevisionDate?.getTime() ===
        revision.nextRevisionDate.getTime()
      ) {
        continue;
      }

      const notification = await prisma.$transaction(async (tx) => {
        const claimed = await tx.spacedRepetition.updateMany({
          where: {
            id: revision.id,
            nextRevisionDate: revision.nextRevisionDate,
            reminderRevisionDate: revision.reminderRevisionDate,
          },
          data: { reminderRevisionDate: revision.nextRevisionDate },
        });
        if (claimed.count === 0) return null;

        return tx.notification.create({
          data: {
            userId: revision.userId,
            title: 'Quiz revision due',
            message: `It is time to revise ${revision.quiz.title}.`,
            type: 'REMINDER',
            relatedId: revision.quizId,
          },
        });
      });

      if (notification) {
        createdCount++;
        emitNotification(
          revision.userId,
          toNotificationDto(notification),
        );
      }
    }

    return createdCount;
  } finally {
    scanInProgress = false;
  }
}

export function startRevisionReminderScheduler(
  intervalMs = DEFAULT_SCAN_INTERVAL_MS,
): void {
  if (timer) return;

  const scan = () => {
    void runRevisionReminderScan().catch((error: unknown) => {
      console.error('Revision reminder scan failed', error);
    });
  };

  scan();
  timer = setInterval(scan, intervalMs);
  timer.unref();
}

export function stopRevisionReminderScheduler(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}
