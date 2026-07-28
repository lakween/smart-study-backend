import path from 'path';
import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.middleware';
import { uploadMemory } from '../middleware/upload.middleware';
import { asyncHandler, ApiError } from '../utils/asyncHandler';
import { generateQuizQuestions } from '../services/ai.service';
import { extractTextFromPdf } from '../services/textExtract.service';
import { createNotification } from '../services/notification.service';

const router = Router();
router.use(requireAuth);

const IMAGE_MIME_TYPES: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
};

const generateBodySchema = z.object({
  questionCount: z.coerce.number().int().min(1).max(30).default(10),
  difficulty: z.enum(['easy', 'medium', 'hard', 'mixed']).default('mixed'),
  learningObjective: z.string().trim().max(200).optional(),
  language: z.string().trim().min(2).max(50).default('English'),
  avoidQuestions: z.preprocess((value) => {
    if (typeof value !== 'string') return value;
    try {
      return JSON.parse(value);
    } catch {
      return [];
    }
  }, z.array(z.string().trim().min(1).max(500)).max(30).default([])),
});

async function generateFromUpload(
  file: Express.Multer.File,
  body: z.infer<typeof generateBodySchema>,
) {
  const ext = path.extname(file.originalname).toLowerCase();
  const common = {
    questionCount: body.questionCount,
    difficulty: body.difficulty,
    learningObjective: body.learningObjective,
    language: body.language,
    avoidQuestions: body.avoidQuestions,
  };

  if (ext === '.pdf') {
    const text = await extractTextFromPdf(file.buffer);
    if (!text || text.length < 20) {
      throw new ApiError(
        422,
        'Could not extract readable text from this PDF. Try a different file.',
      );
    }
    return generateQuizQuestions({ ...common, text });
  }

  const mimeType = IMAGE_MIME_TYPES[ext];
  if (!mimeType) throw new ApiError(400, 'Unsupported file type');
  return generateQuizQuestions({
    ...common,
    imageBuffer: file.buffer,
    imageMimeType: mimeType,
  });
}

router.post(
  '/generate',
  uploadMemory.single('file'),
  asyncHandler(async (req, res) => {
    if (!req.file) throw new ApiError(400, 'No file uploaded');
    const body = generateBodySchema.parse(req.body);
    const questions = await generateFromUpload(req.file, body);

    await createNotification({
      userId: req.userId!,
      title: 'AI Quiz Generated',
      message: `AI generated ${questions.length} questions from "${req.file.originalname}". Review and save when ready.`,
      type: 'AI',
    });

    res.json({ questions });
  })
);

router.post(
  '/regenerate',
  uploadMemory.single('file'),
  asyncHandler(async (req, res) => {
    if (!req.file) throw new ApiError(400, 'No file uploaded');
    const body = generateBodySchema.parse({ ...req.body, questionCount: 1 });
    const questions = await generateFromUpload(req.file, body);
    res.json({ question: questions[0] });
  }),
);

export default router;
