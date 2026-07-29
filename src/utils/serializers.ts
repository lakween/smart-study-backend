import {
  documentTypeFromDb,
  examStatusFromDb,
  examTypeFromDb,
  notificationTypeFromDb,
  studyLevelFromDb,
  visibilityFromDb,
} from './mappers';
import { env } from '../config/env';

export function toUserDto(
  user: any,
  extra: { subjectCount?: number; quizCount?: number; friendCount?: number; quizzesAttempted?: number; avgScore?: number } = {}
) {
  return {
    id: user.id,
    fullName: user.fullName,
    email: user.email,
    bio: user.bio,
    university: user.university,
    studyLevel: studyLevelFromDb(user.studyLevel),
    profileImageUrl: user.profileImageUrl,
    showFriendsOnlyPlaceholders: user.showFriendsOnlyPlaceholders,
    subjectCount: extra.subjectCount ?? 0,
    quizCount: extra.quizCount ?? 0,
    friendCount: extra.friendCount ?? 0,
    quizzesAttempted: extra.quizzesAttempted ?? 0,
    avgScore: extra.avgScore ?? 0,
    createdAt: user.createdAt,
  };
}

export function toQuestionDto(q: any, includeSolution = true) {
  return {
    id: q.id,
    text: q.text,
    optionA: q.optionA,
    optionB: q.optionB,
    optionC: q.optionC,
    optionD: q.optionD,
    ...(includeSolution ? { correctAnswer: q.correctAnswer, explanation: q.explanation } : {}),
  };
}

export function toSubjectDto(s: any, extra: { topicCount?: number; quizCount?: number; avgScore?: number; copiedByCount?: number } = {}) {
  return {
    id: s.id,
    name: s.name,
    description: s.description,
    visibility: visibilityFromDb(s.visibility),
    allowCopy: s.allowCopy,
    isArchived: s.isArchived,
    ownerId: s.ownerId,
    ownerName: s.owner?.fullName,
    ownerImageUrl: s.owner?.profileImageUrl,
    originalCreatorId: s.originalCreatorId,
    originalCreatorName: s.originalCreatorName,
    copiedFromId: s.copiedFromId,
    copiedByCount: extra.copiedByCount ?? 0,
    topicCount: extra.topicCount ?? s._count?.topics ?? 0,
    quizCount: extra.quizCount ?? s._count?.quizzes ?? 0,
    avgScore: extra.avgScore ?? 0,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
  };
}

export function toTopicDto(
  t: any,
  extra: { quizCount?: number; lastScore?: number | null; nextRevisionDate?: Date | null; copiedByCount?: number } = {}
) {
  return {
    id: t.id,
    subjectId: t.subjectId,
    name: t.name,
    description: t.description,
    visibility: visibilityFromDb(t.visibility),
    allowCopy: t.allowCopy,
    originalCreatorId: t.originalCreatorId,
    originalCreatorName: t.originalCreatorName,
    copiedFromId: t.copiedFromId,
    copiedByCount: extra.copiedByCount ?? 0,
    isArchived: t.isArchived,
    quizCount: extra.quizCount ?? t._count?.quizzes ?? 0,
    lastScore: extra.lastScore ?? null,
    nextRevisionDate: extra.nextRevisionDate ?? null,
    createdAt: t.createdAt,
  };
}

export function toDocumentDto(d: any) {
  return {
    id: d.id,
    title: d.title,
    subjectId: d.subjectId,
    subjectName: d.subject?.name,
    topicId: d.topicId,
    topicName: d.topic?.name,
    fileUrl: `${env.publicBaseUrl}/documents/${d.id}/file`,
    fileType: documentTypeFromDb(d.fileType),
    fileSizeBytes: d.fileSizeBytes,
    visibility: visibilityFromDb(d.visibility),
    allowCopy: d.allowCopy,
    ownerId: d.ownerId,
    originalCreatorId: d.originalCreatorId,
    originalCreatorName: d.originalCreatorName,
    copiedFromId: d.copiedFromId,
    uploadedAt: d.uploadedAt,
  };
}

export function toQuizDto(
  q: any,
  extra: {
    attemptCount?: number;
    bestScore?: number | null;
    avgScore?: number | null;
    lastAttemptDate?: Date | null;
    nextRevisionDate?: Date | null;
    revisionIntervalDays?: number | null;
    includeSolutions?: boolean;
    copiedByCount?: number;
  } = {}
) {
  return {
    id: q.id,
    title: q.title,
    subjectId: q.subjectId,
    subjectName: q.subject?.name,
    topicId: q.topicId,
    topicName: q.topic?.name,
    visibility: visibilityFromDb(q.visibility),
    allowCopy: q.allowCopy,
    isAiGenerated: q.isAiGenerated,
    timeLimitMinutes: q.timeLimitMinutes,
    questions: (q.questions ?? []).map((question: any) => toQuestionDto(question, extra.includeSolutions ?? false)),
    ownerId: q.ownerId,
    originalCreatorId: q.originalCreatorId,
    originalCreatorName: q.originalCreatorName,
    copiedFromId: q.copiedFromId,
    copiedByCount: extra.copiedByCount ?? 0,
    attemptCount: extra.attemptCount ?? 0,
    bestScore: extra.bestScore ?? null,
    avgScore: extra.avgScore ?? null,
    lastAttemptDate: extra.lastAttemptDate ?? null,
    nextRevisionDate: extra.nextRevisionDate ?? null,
    revisionIntervalDays: extra.revisionIntervalDays ?? null,
    createdAt: q.createdAt,
  };
}

export function toQuizAttemptDto(a: any) {
  return {
    id: a.id,
    quizId: a.quizId,
    quizTitle: a.quiz?.title,
    subjectId: a.quiz?.subjectId,
    subjectName: a.quiz?.subject?.name,
    topicId: a.quiz?.topicId,
    topicName: a.quiz?.topic?.name,
    isAiGenerated: a.quiz?.isAiGenerated ?? false,
    practiceMode: a.session?.mode === 'TIMED'
      ? 'timed'
      : a.session?.mode === 'UNTIMED'
        ? 'untimed'
        : null,
    userId: a.userId,
    answers: (a.answers ?? []).map((ans: any) => ({
      questionId: ans.questionId,
      selectedAnswer: ans.selectedAnswer,
      isCorrect: ans.isCorrect,
    })),
    correctCount: a.correctCount,
    totalQuestions: a.totalQuestions,
    scorePercent: a.scorePercent,
    timeTakenSeconds: a.timeTakenSeconds,
    attemptedAt: a.attemptedAt,
  };
}

export function toExamDto(e: any) {
  return {
    id: e.id,
    title: e.title,
    subjectId: e.subjectId,
    subjectName: e.subject?.name,
    topicId: e.topicId,
    topicName: e.topic?.name,
    type: examTypeFromDb(e.type),
    status: examStatusFromDb(e.status),
    durationMinutes: e.durationMinutes,
    startTime: e.startTime,
    questions: (e.questions ?? []).map(toQuestionDto),
    organizerId: e.organizerId,
    participants: (e.participants ?? []).map((p: any) => ({
      userId: p.userId,
      name: p.user?.fullName,
      imageUrl: p.user?.profileImageUrl,
      score: p.score,
      timeTakenSeconds: p.timeTakenSeconds,
      hasCompleted: p.hasCompleted,
    })),
    createdAt: e.createdAt,
  };
}

export function toNotificationDto(n: any) {
  return {
    id: n.id,
    title: n.title,
    message: n.message,
    type: notificationTypeFromDb(n.type),
    isRead: n.isRead,
    relatedId: n.relatedId,
    createdAt: n.createdAt,
  };
}

export function toFriendDto(user: any, status: 'friends' | 'pending' | 'sent' | 'none', mutualFriends = 0) {
  return {
    id: user.id,
    fullName: user.fullName,
    email: user.email,
    university: user.university,
    profileImageUrl: user.profileImageUrl,
    mutualFriends,
    status,
  };
}
