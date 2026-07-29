import path from 'path';
import fs from 'fs/promises';
import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { requireAuth } from '../middleware/auth.middleware';
import { upload, UPLOAD_DIR } from '../middleware/upload.middleware';
import { asyncHandler, ApiError } from '../utils/asyncHandler';
import { documentTypeToDb, visibilityToDb } from '../utils/mappers';
import { toDocumentDto } from '../utils/serializers';
import { visibleToViewer, friendshipStatusBetween } from './friends.routes';
import { env } from '../config/env';

const router = Router();
router.use(requireAuth);

const visibilityLevel = (value: string) => {
  if (value === 'PUBLIC' || value === 'public') return 2;
  if (value === 'FRIENDS_ONLY' || value === 'friendsOnly') return 1;
  return 0;
};

async function hasValidFileSignature(filePath: string, extension: string) {
  const handle = await fs.open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(8);
    await handle.read(buffer, 0, buffer.length, 0);
    if (extension === 'pdf') return buffer.subarray(0, 5).toString() === '%PDF-';
    if (extension === 'png') return buffer.equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    if (extension === 'jpg' || extension === 'jpeg') {
      return buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
    }
    return false;
  } finally {
    await handle.close();
  }
}

async function removeFileSafely(filePath: string) {
  try {
    await fs.unlink(filePath);
  } catch (error: any) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

async function requireVisibleDocument(documentId: string, viewerId: string) {
  const document = await prisma.document.findUnique({
    where: { id: documentId },
    include: { subject: true, topic: true },
  });
  if (!document) throw new ApiError(404, 'Document not found');
  const isFriend = (await friendshipStatusBetween(viewerId, document.ownerId)) === 'friends';
  if (!visibleToViewer(document.visibility, document.ownerId, viewerId, isFriend)) {
    throw new ApiError(403, 'You do not have access to this document');
  }
  return document;
}

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
    const document = await requireVisibleDocument(req.params.id, viewerId);
    res.json({ document: toDocumentDto(document) });
  })
);

router.get(
  '/:id/file',
  asyncHandler(async (req, res) => {
    const document = await requireVisibleDocument(req.params.id, req.userId!);
    const filename = path.basename(new URL(document.fileUrl).pathname);
    res.sendFile(path.join(UPLOAD_DIR, filename));
  }),
);

const uploadBodySchema = z.object({
  title: z.string().transform((value) => value.replace(/\0/g, '').trim()).pipe(z.string().min(1).max(150)),
  subjectId: z.string().uuid(),
  topicId: z.string().uuid().optional().or(z.literal('')),
  visibility: z.enum(['private', 'friendsOnly', 'public']).default('private'),
  allowCopy: z.union([z.boolean(), z.string()]).optional(),
});

router.post(
  '/',
  upload.single('file'),
  asyncHandler(async (req, res) => {
    if (!req.file) throw new ApiError(400, 'No file uploaded');
    try {
      const body = uploadBodySchema.parse(req.body);

      const subject = await prisma.subject.findUnique({ where: { id: body.subjectId } });
      if (!subject) throw new ApiError(404, 'Subject not found');
      if (subject.ownerId !== req.userId) throw new ApiError(403, 'Only the subject owner can upload documents');
      const topic = body.topicId
        ? await prisma.topic.findUnique({ where: { id: body.topicId } })
        : null;
      if (body.topicId && (!topic || topic.subjectId !== subject.id)) {
        throw new ApiError(400, 'The selected topic does not belong to this subject');
      }
      if (visibilityLevel(body.visibility) > Math.min(
        visibilityLevel(subject.visibility),
        topic ? visibilityLevel(topic.visibility) : visibilityLevel(subject.visibility),
      )) {
        throw new ApiError(400, 'Document visibility cannot be broader than its topic and subject');
      }

      const ext = path.extname(req.file.originalname).replace('.', '').toLowerCase();
      if (!await hasValidFileSignature(req.file.path, ext)) {
        throw new ApiError(400, 'File contents do not match the selected PDF or image type');
      }
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
    } catch (error) {
      await removeFileSafely(req.file.path);
      throw error;
    }
  })
);

const updateVisibilitySchema = z.object({
  visibility: z.enum(['private', 'friendsOnly', 'public']),
  allowCopy: z.boolean().optional(),
});

router.patch(
  '/:id',
  asyncHandler(async (req, res) => {
    const existing = await prisma.document.findUnique({
      where: { id: req.params.id },
      include: { subject: true, topic: true },
    });
    if (!existing) throw new ApiError(404, 'Document not found');
    if (existing.ownerId !== req.userId) throw new ApiError(403, 'Only the owner can edit this document');

    const body = updateVisibilitySchema.parse(req.body);
    if (visibilityLevel(body.visibility) > Math.min(
      visibilityLevel(existing.subject.visibility),
      existing.topic ? visibilityLevel(existing.topic.visibility) : visibilityLevel(existing.subject.visibility),
    )) {
      throw new ApiError(400, 'Document visibility cannot be broader than its topic and subject');
    }
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
    const remainingReferences = await prisma.document.count({ where: { fileUrl: existing.fileUrl } });
    if (remainingReferences === 0) {
      const filename = path.basename(new URL(existing.fileUrl).pathname);
      await removeFileSafely(path.join(UPLOAD_DIR, filename));
    }
    res.json({ success: true });
  })
);

router.post(
  '/:id/copy',
  asyncHandler(async (req, res) => {
    const viewerId = req.userId!;
    const source = await requireVisibleDocument(req.params.id, viewerId);
    if (source.ownerId !== viewerId && !source.allowCopy) {
      throw new ApiError(403, 'The owner has not allowed copying this document');
    }

    const body = z.object({
      targetSubjectId: z.string().uuid(),
      targetTopicId: z.string().uuid().nullable().optional(),
    }).parse(req.body);

    const copy = await prisma.$transaction(async (tx) => {
      const targetSubject = await tx.subject.findUnique({ where: { id: body.targetSubjectId } });
      if (!targetSubject || targetSubject.ownerId !== viewerId || targetSubject.isArchived) {
        throw new ApiError(400, 'Choose one of your active subjects');
      }
      const targetTopic = body.targetTopicId
        ? await tx.topic.findUnique({ where: { id: body.targetTopicId } })
        : null;
      if (body.targetTopicId && (!targetTopic || targetTopic.subjectId !== targetSubject.id || targetTopic.isArchived)) {
        throw new ApiError(400, 'Choose a topic in the selected subject');
      }

      return tx.document.create({
        data: {
          title: `${source.title} (Copy)`,
          subjectId: targetSubject.id,
          topicId: targetTopic?.id ?? null,
          fileUrl: source.fileUrl,
          fileType: source.fileType,
          fileSizeBytes: source.fileSizeBytes,
          visibility: 'PRIVATE',
          allowCopy: false,
          ownerId: viewerId,
          originalCreatorId: source.originalCreatorId ?? source.ownerId,
          originalCreatorName: source.originalCreatorName ?? (await tx.user.findUniqueOrThrow({ where: { id: source.ownerId } })).fullName,
          copiedFromId: source.id,
        },
        include: { subject: true, topic: true },
      });
    });
    res.status(201).json({ document: toDocumentDto(copy) });
  })
);

export default router;
