import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { requireAuth } from '../middleware/auth.middleware';
import { upload } from '../middleware/upload.middleware';
import { asyncHandler, ApiError } from '../utils/asyncHandler';
import { studyLevelToDb } from '../utils/mappers';
import { toUserDto, toSubjectDto, toQuizDto } from '../utils/serializers';
import { getUserStats } from '../utils/userStats';
import { env } from '../config/env';
import { visibleToViewer, friendshipStatusBetween } from './friends.routes';

const router = Router();

const updateProfileSchema = z.object({
  fullName: z.string().min(2).optional(),
  bio: z.string().nullable().optional(),
  university: z.string().nullable().optional(),
  studyLevel: z.string().optional(),
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

    const [subjects, quizzes] = await Promise.all([
      prisma.subject.findMany({
        where: { ownerId: userId },
        include: { owner: true, _count: { select: { topics: true, quizzes: true } } },
        orderBy: { createdAt: 'desc' },
      }),
      prisma.quiz.findMany({
        where: { ownerId: userId },
        include: { subject: true, topic: true, questions: true },
        orderBy: { createdAt: 'desc' },
      }),
    ]);

    const isFriend = friendStatus === 'friends';
    const visibleSubjects = subjects.filter((s) => visibleToViewer(s.visibility, s.ownerId, viewerId, isFriend));
    const visibleQuizzes = quizzes.filter((q) => visibleToViewer(q.visibility, q.ownerId, viewerId, isFriend));

    res.json({
      user: toUserDto(user, stats),
      friendStatus,
      subjects: visibleSubjects.map((s) => toSubjectDto(s)),
      quizzes: visibleQuizzes.map((q) => toQuizDto(q)),
    });
  })
);

export default router;
