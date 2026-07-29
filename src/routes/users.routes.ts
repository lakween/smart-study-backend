import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { requireAuth } from '../middleware/auth.middleware';
import { upload } from '../middleware/upload.middleware';
import { asyncHandler, ApiError } from '../utils/asyncHandler';
import { studyLevelToDb } from '../utils/mappers';
import { toUserDto, toSubjectDto, toTopicDto, toDocumentDto, toQuizDto } from '../utils/serializers';
import { getUserStats } from '../utils/userStats';
import { env } from '../config/env';
import { visibleToViewer, friendshipStatusBetween } from './friends.routes';
import { quizCopyCounts, subjectCopyCounts, topicCopyCounts } from '../utils/copyStats';

const router = Router();

const updateProfileSchema = z.object({
  fullName: z.string().min(2).optional(),
  bio: z.string().nullable().optional(),
  university: z.string().nullable().optional(),
  studyLevel: z.string().optional(),
  showFriendsOnlyPlaceholders: z.boolean().optional(),
});

router.patch(
  '/me',
  requireAuth,
  asyncHandler(async (req, res) => {
    const body = updateProfileSchema.parse(req.body);
    const user = await prisma.user.update({
      where: { id: req.userId },
      data: {
        fullName: body.fullName,
        bio: body.bio,
        university: body.university,
        studyLevel: body.studyLevel ? studyLevelToDb(body.studyLevel) : undefined,
        showFriendsOnlyPlaceholders: body.showFriendsOnlyPlaceholders,
      },
    });
    const stats = await getUserStats(user.id);
    res.json({ user: toUserDto(user, stats) });
  })
);

router.post(
  '/me/avatar',
  requireAuth,
  upload.single('file'),
  asyncHandler(async (req, res) => {
    if (!req.file) throw new ApiError(400, 'No file uploaded');
    const profileImageUrl = `${env.publicBaseUrl}/uploads/${req.file.filename}`;
    const user = await prisma.user.update({ where: { id: req.userId }, data: { profileImageUrl } });
    const stats = await getUserStats(user.id);
    res.json({ user: toUserDto(user, stats) });
  })
);

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(8),
});

router.post(
  '/me/change-password',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { currentPassword, newPassword } = changePasswordSchema.parse(req.body);
    const user = await prisma.user.findUniqueOrThrow({ where: { id: req.userId } });
    const valid = await bcrypt.compare(currentPassword, user.passwordHash);
    if (!valid) throw new ApiError(401, 'Current password is incorrect');
    const passwordHash = await bcrypt.hash(newPassword, 10);
    await prisma.user.update({ where: { id: user.id }, data: { passwordHash } });
    res.json({ success: true });
  })
);

const updateEmailSchema = z.object({
  newEmail: z.string().email(),
  password: z.string().min(1),
});

router.post(
  '/me/change-email',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { newEmail, password } = updateEmailSchema.parse(req.body);
    const user = await prisma.user.findUniqueOrThrow({ where: { id: req.userId } });
    const valid = await bcrypt.compare(password, user.passwordHash);
    if (!valid) throw new ApiError(401, 'Password is incorrect');
    const existing = await prisma.user.findUnique({ where: { email: newEmail.toLowerCase() } });
    if (existing) throw new ApiError(409, 'Email already in use');
    const updated = await prisma.user.update({ where: { id: user.id }, data: { email: newEmail.toLowerCase() } });
    const stats = await getUserStats(updated.id);
    res.json({ user: toUserDto(updated, stats) });
  })
);

router.delete(
  '/me',
  requireAuth,
  asyncHandler(async (req, res) => {
    await prisma.user.delete({ where: { id: req.userId } });
    res.json({ success: true });
  })
);

router.get(
  '/:userId/profile',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { userId } = req.params;
    const viewerId = req.userId!;
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new ApiError(404, 'User not found');

    const stats = await getUserStats(userId);
    const friendStatus = await friendshipStatusBetween(viewerId, userId);

    const [subjects, topics, documents, quizzes] = await Promise.all([
      prisma.subject.findMany({
        where: { ownerId: userId },
        include: { owner: true, _count: { select: { topics: true, quizzes: true } } },
        orderBy: { createdAt: 'desc' },
      }),
      prisma.topic.findMany({
        where: { subject: { ownerId: userId } },
        include: { subject: true, _count: { select: { quizzes: true } } },
        orderBy: { createdAt: 'desc' },
      }),
      prisma.document.findMany({
        where: { ownerId: userId },
        include: { subject: true, topic: true },
        orderBy: { uploadedAt: 'desc' },
      }),
      prisma.quiz.findMany({
        where: { ownerId: userId },
        include: { subject: true, topic: true, questions: true },
        orderBy: { createdAt: 'desc' },
      }),
    ]);

    const isFriend = friendStatus === 'friends';
    const showLockedPlaceholders = viewerId !== userId && !isFriend && user.showFriendsOnlyPlaceholders;
    const visibleSubjects = subjects.filter((s) => visibleToViewer(s.visibility, s.ownerId, viewerId, isFriend));
    const visibleSubjectIds = new Set(visibleSubjects.map((subject) => subject.id));
    const visibleTopics = topics.filter((topic) =>
      visibleSubjectIds.has(topic.subjectId) && visibleToViewer(topic.visibility, userId, viewerId, isFriend),
    );
    const visibleTopicIds = new Set(visibleTopics.map((topic) => topic.id));
    const visibleDocuments = documents.filter((document) =>
      visibleSubjectIds.has(document.subjectId) &&
      (!document.topicId || visibleTopicIds.has(document.topicId)) &&
      visibleToViewer(document.visibility, document.ownerId, viewerId, isFriend),
    );
    const visibleQuizzes = quizzes.filter((quiz) =>
      visibleSubjectIds.has(quiz.subjectId) &&
      visibleTopicIds.has(quiz.topicId) &&
      visibleToViewer(quiz.visibility, quiz.ownerId, viewerId, isFriend),
    );
    const topicCountBySubject = new Map<string, number>();
    const quizCountBySubject = new Map<string, number>();
    const quizCountByTopic = new Map<string, number>();
    for (const topic of visibleTopics) {
      topicCountBySubject.set(topic.subjectId, (topicCountBySubject.get(topic.subjectId) ?? 0) + 1);
    }
    for (const quiz of visibleQuizzes) {
      quizCountBySubject.set(quiz.subjectId, (quizCountBySubject.get(quiz.subjectId) ?? 0) + 1);
      quizCountByTopic.set(quiz.topicId, (quizCountByTopic.get(quiz.topicId) ?? 0) + 1);
    }
    const [subjectCopies, topicCopies, quizCopies] = await Promise.all([
      subjectCopyCounts(visibleSubjects.map((subject) => subject.id)),
      topicCopyCounts(visibleTopics.map((topic) => topic.id)),
      quizCopyCounts(visibleQuizzes.map((quiz) => quiz.id)),
    ]);

    res.json({
      user: toUserDto(user, {
        ...stats,
        subjectCount: visibleSubjects.length,
        quizCount: visibleQuizzes.length,
      }),
      friendStatus,
      lockedContent: {
        subjects: showLockedPlaceholders && subjects.some((subject) => subject.visibility === 'FRIENDS_ONLY'),
        topics: showLockedPlaceholders && topics.some((topic) => topic.visibility === 'FRIENDS_ONLY' || topic.subject.visibility === 'FRIENDS_ONLY'),
        documents: showLockedPlaceholders && documents.some((document) => document.visibility === 'FRIENDS_ONLY' || document.subject.visibility === 'FRIENDS_ONLY' || document.topic?.visibility === 'FRIENDS_ONLY'),
        quizzes: showLockedPlaceholders && quizzes.some((quiz) => quiz.visibility === 'FRIENDS_ONLY' || quiz.subject.visibility === 'FRIENDS_ONLY' || quiz.topic.visibility === 'FRIENDS_ONLY'),
      },
      subjects: visibleSubjects.map((subject) => toSubjectDto(subject, {
        topicCount: topicCountBySubject.get(subject.id) ?? 0,
        quizCount: quizCountBySubject.get(subject.id) ?? 0,
        copiedByCount: subjectCopies.get(subject.id) ?? 0,
      })),
      topics: visibleTopics.map((topic) => toTopicDto(topic, {
        quizCount: quizCountByTopic.get(topic.id) ?? 0,
        copiedByCount: topicCopies.get(topic.id) ?? 0,
      })),
      documents: visibleDocuments.map(toDocumentDto),
      quizzes: visibleQuizzes.map((q) => toQuizDto(q, { copiedByCount: quizCopies.get(q.id) ?? 0 })),
    });
  })
);

export default router;
