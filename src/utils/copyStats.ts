import { prisma } from '../lib/prisma';

function toCountMap(rows: Array<{ copiedFromId: string | null; ownerId: string }>) {
  const ownersBySource = new Map<string, Set<string>>();
  for (const row of rows) {
    if (!row.copiedFromId) continue;
    const owners = ownersBySource.get(row.copiedFromId) ?? new Set<string>();
    owners.add(row.ownerId);
    ownersBySource.set(row.copiedFromId, owners);
  }
  return new Map([...ownersBySource].map(([sourceId, owners]) => [sourceId, owners.size]));
}

export async function subjectCopyCounts(ids: string[]) {
  if (ids.length === 0) return new Map<string, number>();
  return toCountMap(await prisma.subject.findMany({
    where: { copiedFromId: { in: ids } },
    select: { copiedFromId: true, ownerId: true },
  }));
}

export async function topicCopyCounts(ids: string[]) {
  if (ids.length === 0) return new Map<string, number>();
  const rows = await prisma.topic.findMany({
    where: { copiedFromId: { in: ids } },
    select: { copiedFromId: true, subject: { select: { ownerId: true } } },
  });
  return toCountMap(rows.map((row) => ({ copiedFromId: row.copiedFromId, ownerId: row.subject.ownerId })));
}

export async function quizCopyCounts(ids: string[]) {
  if (ids.length === 0) return new Map<string, number>();
  return toCountMap(await prisma.quiz.findMany({
    where: { copiedFromId: { in: ids } },
    select: { copiedFromId: true, ownerId: true },
  }));
}
