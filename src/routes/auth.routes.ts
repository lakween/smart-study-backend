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
import { env } from '../config/env';

const router = Router();

const hashToken = (token: string) => crypto.createHash('sha256').update(token).digest('hex');

async function issueSession(userId: string) {
  const token = signToken({ userId });
  const refreshToken = crypto.randomBytes(48).toString('base64url');
  await prisma.$transaction([
    prisma.refreshToken.deleteMany({
      where: {
        userId,
        OR: [{ expiresAt: { lt: new Date() } }, { revokedAt: { not: null } }],
      },
    }),
    prisma.refreshToken.create({
      data: {
        userId,
        tokenHash: hashToken(refreshToken),
        expiresAt: new Date(Date.now() + env.refreshTokenExpiresDays * 24 * 60 * 60_000),
      },
    }),
  ]);
  return { token, refreshToken };
}

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

    const session = await issueSession(user.id);
    const stats = await getUserStats(user.id);
    res.status(201).json({ ...session, user: toUserDto(user, stats) });
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

    const session = await issueSession(user.id);
    const stats = await getUserStats(user.id);
    res.json({ ...session, user: toUserDto(user, stats) });
  })
);

const refreshSchema = z.object({ refreshToken: z.string().min(20) });

router.post(
  '/refresh',
  asyncHandler(async (req, res) => {
    const { refreshToken } = refreshSchema.parse(req.body);
    const stored = await prisma.refreshToken.findUnique({
      where: { tokenHash: hashToken(refreshToken) },
    });
    if (!stored || stored.revokedAt || stored.expiresAt <= new Date()) {
      throw new ApiError(401, 'Invalid or expired refresh token');
    }

    const nextRefreshToken = crypto.randomBytes(48).toString('base64url');
    await prisma.$transaction(async (tx) => {
      const claimed = await tx.refreshToken.updateMany({
        where: { id: stored.id, revokedAt: null, expiresAt: { gt: new Date() } },
        data: { revokedAt: new Date() },
      });
      if (claimed.count !== 1) throw new ApiError(401, 'Invalid or expired refresh token');
      await tx.refreshToken.create({
        data: {
          userId: stored.userId,
          tokenHash: hashToken(nextRefreshToken),
          expiresAt: new Date(Date.now() + env.refreshTokenExpiresDays * 24 * 60 * 60_000),
        },
      });
    });
    res.json({ token: signToken({ userId: stored.userId }), refreshToken: nextRefreshToken });
  }),
);

router.post(
  '/logout',
  asyncHandler(async (req, res) => {
    const parsed = refreshSchema.safeParse(req.body);
    if (parsed.success) {
      await prisma.refreshToken.updateMany({
        where: { tokenHash: hashToken(parsed.data.refreshToken), revokedAt: null },
        data: { revokedAt: new Date() },
      });
    }
    res.json({ success: true });
  }),
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

    const resetToken = crypto.randomBytes(32).toString('hex');
    const tokenHash = hashToken(resetToken);
    const passwordResetExpiresAt = new Date(Date.now() + env.passwordResetTtlMinutes * 60_000);
    await prisma.user.update({
      where: { id: user.id },
      data: { passwordResetToken: tokenHash, passwordResetExpiresAt },
    });

    if (!env.isProduction) {
      console.log(`\n[Password Reset] Reset token for ${user.email}: ${resetToken}\n`);
    } else {
      console.warn(JSON.stringify({
        level: 'warn',
        event: 'password_reset_delivery_not_configured',
        userId: user.id,
      }));
    }

    res.json({
      success: true,
      devResetToken: env.isProduction ? undefined : resetToken,
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
    const tokenHash = hashToken(token);
    if (!user || !user.passwordResetToken || !user.passwordResetExpiresAt ||
        user.passwordResetToken !== tokenHash || user.passwordResetExpiresAt <= new Date()) {
      throw new ApiError(400, 'Invalid or expired reset token');
    }
    const passwordHash = await bcrypt.hash(newPassword, 10);
    await prisma.$transaction([
      prisma.user.update({
        where: { id: user.id },
        data: { passwordHash, passwordResetToken: null, passwordResetExpiresAt: null },
      }),
      prisma.refreshToken.updateMany({
        where: { userId: user.id, revokedAt: null },
        data: { revokedAt: new Date() },
      }),
    ]);
    res.json({ success: true });
  })
);

export default router;
