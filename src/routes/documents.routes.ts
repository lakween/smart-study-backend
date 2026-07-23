import path from 'path';
import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { requireAuth } from '../middleware/auth.middleware';
import { upload } from '../middleware/upload.middleware';
import { asyncHandler, ApiError } from '../utils/asyncHandler';
import { documentTypeToDb, visibilityToDb } from '../utils/mappers';
import { toDocumentDto } from '../utils/serializers';
import { visibleToViewer, friendshipStatusBetween } from './friends.routes';
import { env } from '../config/env';

const router = Router();
router.use(requireAuth);

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const viewerId = req.userId!;
    const subjectId = req.query.subjectId as string | undefined;
    const topicId = req.query.topicId as string | undefined;

    const documents = await prisma.document.findMany({
      where: { subjectId, topicId },
      include: { subject: true, topic: true },
      orderBy: { uploadedAt: 'desc' },
    });

    const visible = [];
    for (const d of documents) {
      if (d.ownerId === viewerId) {
        visible.push(d);
        continue;
      }
      const isFriend = (await friendshipStatusBetween(viewerId, d.ownerId)) === 'friends';
      if (visibleToViewer(d.visibility, d.ownerId, viewerId, isFriend)) visible.push(d);
    }

    res.json({ documents: visible.map(toDocumentDto) });
  })
);

router.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const viewerId = req.userId!;
    const document = await prisma.document.findUnique({
      where: { id: req.params.id },
      include: { subject: true, topic: true },
    });
    if (!document) throw new ApiError(404, 'Document not found');
    const isFriend = (await friendshipStatusBetween(viewerId, document.ownerId)) === 'friends';
    if (!visibleToViewer(document.visibility, document.ownerId, viewerId, isFriend)) {
      throw new ApiError(403, 'You do not have access to this document');
    }
    res.json({ document: toDocumentDto(document) });
  })
);

const uploadBodySchema = z.object({
  title: z.string().min(1),
  subjectId: z.string().uuid(),
  topicId: z.string().uuid().optional().or(z.literal('')),
  visibility: z.string().default('private'),
  allowCopy: z.union([z.boolean(), z.string()]).optional(),
});

router.post(
  '/',
  upload.single('file'),
  asyncHandler(async (req, res) => {
    if (!req.file) throw new ApiError(400, 'No file uploaded');
    const body = uploadBodySchema.parse(req.body);

    const subject = await prisma.subject.findUnique({ where: { id: body.subjectId } });
    if (!subject) throw new ApiError(404, 'Subject not found');

    const ext = path.extname(req.file.originalname).replace('.', '');
    const document = await prisma.document.create({
      data: {
        title: body.title,
        subjectId: body.subjectId,
        topicId: body.topicId || null,
        fileUrl: `${env.publicBaseUrl}/uploads/${req.file.filename}`,
        fileType: documentTypeToDb(ext),
        fileSizeBytes: req.file.size,
        visibility: visibilityToDb(body.visibility),
        allowCopy: body.allowCopy === true || body.allowCopy === 'true',
        ownerId: req.userId!,
      },
      include: { subject: true, topic: true },
    });
    res.status(201).json({ document: toDocumentDto(document) });
  })
);

const updateVisibilitySchema = z.object({ visibility: z.string(), allowCopy: z.boolean().optional() });

router.patch(
  '/:id',
  asyncHandler(async (req, res) => {
    const existing = await prisma.document.findUnique({ where: { id: req.params.id } });
    if (!existing) throw new ApiError(404, 'Document not found');
    if (existing.ownerId !== req.userId) throw new ApiError(403, 'Only the owner can edit this document');

    const body = updateVisibilitySchema.parse(req.body);
    const updated = await prisma.document.update({
      where: { id: req.params.id },
      data: { visibility: visibilityToDb(body.visibility), allowCopy: body.allowCopy },
      include: { subject: true, topic: true },
    });
    res.json({ document: toDocumentDto(updated) });
  })
);

router.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const existing = await prisma.document.findUnique({ where: { id: req.params.id } });
    if (!existing) throw new ApiError(404, 'Document not found');
    if (existing.ownerId !== req.userId) throw new ApiError(403, 'Only the owner can delete this document');
    await prisma.document.delete({ where: { id: req.params.id } });
    res.json({ success: true });
  })
);

router.post(
  '/:id/copy',
  asyncHandler(async (req, res) => {
    const viewerId = req.userId!;
    const source = await prisma.document.findUnique({ where: { id: req.params.id } });
    if (!source) throw new ApiError(404, 'Document not found');
    if (!source.allowCopy) throw new ApiError(403, 'The owner has not allowed copying this document');

    const copy = await prisma.document.create({
      data: {
        title: `${source.title} (Copy)`,
        subjectId: source.subjectId,
        topicId: source.topicId,
        fileUrl: source.fileUrl,
        fileType: source.fileType,
        fileSizeBytes: source.fileSizeBytes,
        visibility: 'PRIVATE',
        allowCopy: false,
        ownerId: viewerId,
      },
      include: { subject: true, topic: true },
    });
    res.status(201).json({ document: toDocumentDto(copy) });
  })
);

export default router;
