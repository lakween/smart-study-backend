import path from 'path';
import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.middleware';
import { uploadMemory } from '../middleware/upload.middleware';
import { asyncHandler, ApiError } from '../utils/asyncHandler';
import { generateQuizQuestions } from '../services/ai.service';
import { extractTextFromPdf } from '../services/textExtract.service';
import { prisma } from '../lib/prisma';

const router = Router();
router.use(requireAuth);

const IMAGE_MIME_TYPES: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
};

const generateBodySchema = z.object({
  questionCount: z.coerce.number().int().min(1).max(30).default(10),
});

router.post(
  '/generate',
  uploadMemory.single('file'),
  asyncHandler(async (req, res) => {
    if (!req.file) throw new ApiError(400, 'No file uploaded');
    const { questionCount } = generateBodySchema.parse(req.body);
    const ext = path.extname(req.file.originalname).toLowerCase();

    let questions;
    if (ext === '.pdf') {
      const text = await extractTextFromPdf(req.file.buffer);
      if (!text || text.length < 20) {
        throw new ApiError(422, 'Could not extract readable text from this PDF. Try a different file.');
      }
      questions = await generateQuizQuestions({ questionCount, text });
    } else {
      const mimeType = IMAGE_MIME_TYPES[ext];
      if (!mimeType) throw new ApiError(400, 'Unsupported file type');
      questions = await generateQuizQuestions({ questionCount, imageBuffer: req.file.buffer, imageMimeType: mimeType });
    }

    await prisma.notification.create({
      data: {
        userId: req.userId!,
        title: 'AI Quiz Generated',
        message: `AI generated ${questions.length} questions from "${req.file.originalname}". Review and save when ready.`,
        type: 'AI',
      },
    });

    res.json({ questions });
  })
);

export default router;
