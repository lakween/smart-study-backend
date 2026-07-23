import { Router } from 'express';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { asyncHandler, ApiError } from '../utils/asyncHandler';
import { signToken } from '../utils/jwt';
import { requireAuth } from '../middleware/auth.middleware';
import { studyLevelToDb } from '../utils/mappers';
import { toUserDto } from '../utils/serializers';
import { getUserStats } from '../utils/userStats';

const router = Router();

const registerSchema = z.object({
  fullName: z.string().min(2),
  email: z.string().email(),
  password: z.string().min(8),
  university: z.string().optional().nullable(),
  studyLevel: z.string().optional().default('undergraduate'),
});

router.post(
  '/register',
  asyncHandler(async (req, res) => {
    const body = registerSchema.parse(req.body);
    const existing = await prisma.user.findUnique({ where: { email: body.email.toLowerCase() } });
    if (existing) throw new ApiError(409, 'An account with this email already exists');

    const passwordHash = await bcrypt.hash(body.password, 10);
    const user = await prisma.user.create({
      data: {
        fullName: body.fullName,
        email: body.email.toLowerCase(),
        passwordHash,
        university: body.university || null,
        studyLevel: studyLevelToDb(body.studyLevel ?? 'undergraduate'),
      },
    });

    const token = signToken({ userId: user.id });
    const stats = await getUserStats(user.id);
    res.status(201).json({ token, user: toUserDto(user, stats) });
  })
);

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

router.post(
  '/login',
  asyncHandler(async (req, res) => {
    const body = loginSchema.parse(req.body);
    const user = await prisma.user.findUnique({ where: { email: body.email.toLowerCase() } });
    if (!user) throw new ApiError(401, 'Invalid email or password');

    const valid = await bcrypt.compare(body.password, user.passwordHash);
    if (!valid) throw new ApiError(401, 'Invalid email or password');

    const token = signToken({ userId: user.id });
    const stats = await getUserStats(user.id);
    res.json({ token, user: toUserDto(user, stats) });
  })
);

router.get(
  '/me',
  requireAuth,
  asyncHandler(async (req, res) => {
    const user = await prisma.user.findUnique({ where: { id: req.userId } });
    if (!user) throw new ApiError(404, 'User not found');
    const stats = await getUserStats(user.id);
    res.json({ user: toUserDto(user, stats) });
  })
);

const forgotPasswordSchema = z.object({ email: z.string().email() });

// Dev-mode password reset: no email provider is configured, so the reset
// token is logged to the server console (and echoed back in the response
// only when NODE_ENV !== 'production') instead of being emailed.
router.post(
  '/forgot-password',
  asyncHandler(async (req, res) => {
    const { email } = forgotPasswordSchema.parse(req.body);
    const user = await prisma.user.findUnique({ where: { email: email.toLowerCase() } });

    // Always return success so we don't leak whether an email is registered.
    if (!user) {
      res.json({ success: true });
      return;
    }

    const resetToken = crypto.randomBytes(24).toString('hex');
    await prisma.user.update({ where: { id: user.id }, data: { passwordResetToken: resetToken } });

    console.log(`\n[Password Reset] Reset token for ${user.email}: ${resetToken}\n`);

    res.json({
      success: true,
      devResetToken: process.env.NODE_ENV === 'production' ? undefined : resetToken,
    });
  })
);

const resetPasswordSchema = z.object({
  email: z.string().email(),
  token: z.string().min(1),
  newPassword: z.string().min(8),
});

router.post(
  '/reset-password',
  asyncHandler(async (req, res) => {
    const { email, token, newPassword } = resetPasswordSchema.parse(req.body);
    const user = await prisma.user.findUnique({ where: { email: email.toLowerCase() } });
    if (!user || !user.passwordResetToken || user.passwordResetToken !== token) {
      throw new ApiError(400, 'Invalid or expired reset token');
    }
    const passwordHash = await bcrypt.hash(newPassword, 10);
    await prisma.user.update({
      where: { id: user.id },
      data: { passwordHash, passwordResetToken: null },
    });
    res.json({ success: true });
  })
);

export default router;
