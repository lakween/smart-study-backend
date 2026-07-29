import { GoogleGenAI } from '@google/genai';
import OpenAI from 'openai';
import { zodTextFormat } from 'openai/helpers/zod';
import { z } from 'zod';

import { env } from '../config/env';

export type QuizDifficulty = 'easy' | 'medium' | 'hard' | 'mixed';
type AiProvider = 'openai' | 'gemini';

const answerSchema = z.enum(['A', 'B', 'C', 'D']);

const questionSchema = z
  .object({
    text: z.string().min(5).max(500),
    optionA: z.string().min(1).max(250),
    optionB: z.string().min(1).max(250),
    optionC: z.string().min(1).max(250),
    optionD: z.string().min(1).max(250),
    correctAnswer: answerSchema,
    explanation: z.string().min(1).max(750),
    sourceExcerpt: z.string().min(1).max(750),
  })
  .strict();

export type GeneratedQuestion = z.infer<typeof questionSchema>;

const quizJsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['questions'],
  properties: {
    questions: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: [
          'text',
          'optionA',
          'optionB',
          'optionC',
          'optionD',
          'correctAnswer',
          'explanation',
          'sourceExcerpt',
        ],
        properties: {
          text: { type: 'string' },
          optionA: { type: 'string' },
          optionB: { type: 'string' },
          optionC: { type: 'string' },
          optionD: { type: 'string' },
          correctAnswer: { type: 'string', enum: ['A', 'B', 'C', 'D'] },
          explanation: { type: 'string' },
          sourceExcerpt: { type: 'string' },
        },
      },
    },
  },
} as const;

export async function generateQuizQuestions(params: {
  questionCount: number;
  difficulty: QuizDifficulty;
  learningObjective?: string;
  language: string;
  avoidQuestions?: string[];
  text?: string;
  imageBuffer?: Buffer;
  imageMimeType?: string;
}): Promise<GeneratedQuestion[]> {
  const provider = selectedProvider();
  assertProviderConfigured(provider);

  const resultSchema = z
    .object({ questions: z.array(questionSchema).length(params.questionCount) })
    .strict();
  const material = params.text ? sampleStudyMaterial(params.text) : null;
  const avoidList = (params.avoidQuestions ?? [])
    .map((question) => question.trim())
    .filter(Boolean)
    .slice(0, 30);
  const instructions = buildInstructions(params, avoidList);

  let lastValidationError: Error | null = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const parsed =
        provider === 'openai'
          ? await generateWithOpenAi(params, instructions, material, resultSchema)
          : await generateWithGemini(params, instructions, material, resultSchema);
      return validateQuestionQuality(parsed.questions, avoidList);
    } catch (error) {
      lastValidationError =
        error instanceof Error ? error : new Error('Invalid quiz output');
    }
  }

  throw (
    lastValidationError ??
    new Error(`${providerLabel(provider)} could not generate a valid quiz.`)
  );
}

async function generateWithOpenAi(
  params: Parameters<typeof generateQuizQuestions>[0],
  instructions: string,
  material: string | null,
  resultSchema: z.ZodType<{ questions: GeneratedQuestion[] }>,
) {
  const client = new OpenAI({ apiKey: env.openAiApiKey });
  const content: Array<
    | { type: 'input_text'; text: string }
    | { type: 'input_image'; image_url: string; detail: 'high' }
  > = [];

  if (material) {
    content.push({ type: 'input_text', text: `Study material:\n${material}` });
  }
  if (params.imageBuffer && params.imageMimeType) {
    content.push({
      type: 'input_image',
      image_url: `data:${params.imageMimeType};base64,${params.imageBuffer.toString('base64')}`,
      detail: 'high',
    });
  }

  const response = await client.responses.parse({
    model: env.openAiModel,
    instructions,
    input: [{ role: 'user', content }],
    reasoning: { effort: 'none' },
    text: { format: zodTextFormat(resultSchema, 'smart_study_quiz') },
    store: false,
  });
  if (!response.output_parsed) {
    throw new Error('OpenAI did not return a valid structured quiz.');
  }
  return resultSchema.parse(response.output_parsed);
}

async function generateWithGemini(
  params: Parameters<typeof generateQuizQuestions>[0],
  instructions: string,
  material: string | null,
  resultSchema: z.ZodType<{ questions: GeneratedQuestion[] }>,
) {
  const client = new GoogleGenAI({ apiKey: env.geminiApiKey });
  const parts: Array<
    | { text: string }
    | { inlineData: { data: string; mimeType: string } }
  > = [{ text: instructions }];

  if (material) parts.push({ text: `Study material:\n${material}` });
  if (params.imageBuffer && params.imageMimeType) {
    parts.push({
      inlineData: {
        data: params.imageBuffer.toString('base64'),
        mimeType: params.imageMimeType,
      },
    });
  }

  const response = await client.models.generateContent({
    model: env.geminiModel,
    contents: [{ role: 'user', parts }],
    config: {
      responseMimeType: 'application/json',
      responseJsonSchema: quizJsonSchema,
    },
  });
  if (!response.text) {
    throw new Error('Gemini did not return a structured quiz.');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(response.text);
  } catch {
    throw new Error('Gemini returned invalid JSON.');
  }
  return resultSchema.parse(parsed);
}

function buildInstructions(
  params: Parameters<typeof generateQuizQuestions>[0],
  avoidList: string[],
): string {
  return `You are an expert teacher creating a grounded multiple-choice quiz.

Success criteria:
- Generate exactly ${params.questionCount} questions in ${params.language}.
- Difficulty: ${params.difficulty}. For "mixed", use a balanced progression from recall to application.
- Base every answer only on the supplied study material. Do not use outside knowledge.
- Each question has four distinct, plausible options and exactly one unambiguous correct answer.
- Avoid duplicate or near-duplicate questions and options.
- Do not use "all of the above" or "none of the above".
- Include a concise explanation and a short verbatim source excerpt supporting the answer.
- Distribute correct answers across A, B, C, and D instead of favoring one position.
${params.learningObjective ? `- Prioritize this learning objective: ${params.learningObjective}` : ''}
${avoidList.length > 0 ? `- Do not repeat these questions:\n${avoidList.map((q) => `  - ${q}`).join('\n')}` : ''}

If the material does not support enough high-quality questions, focus on distinct facts or applications explicitly supported by the material.`;
}

function selectedProvider(): AiProvider {
  return env.aiProvider;
}

function assertProviderConfigured(provider: AiProvider): void {
  if (provider === 'openai' && !env.openAiApiKey) {
    throw new Error(
      'AI_PROVIDER is openai but OPENAI_API_KEY is not configured in backend/.env.',
    );
  }
  if (provider === 'gemini' && !env.geminiApiKey) {
    throw new Error(
      'AI_PROVIDER is gemini but GEMINI_API_KEY is not configured in backend/.env.',
    );
  }
}

function providerLabel(provider: AiProvider): string {
  return provider === 'openai' ? 'OpenAI' : 'Gemini';
}

function validateQuestionQuality(
  questions: GeneratedQuestion[],
  avoidQuestions: string[],
): GeneratedQuestion[] {
  const seenQuestions = new Set(avoidQuestions.map(normalize));

  for (const question of questions) {
    const normalizedQuestion = normalize(question.text);
    if (seenQuestions.has(normalizedQuestion)) {
      throw new Error('The AI provider generated a duplicate question.');
    }
    seenQuestions.add(normalizedQuestion);

    const options = [
      question.optionA,
      question.optionB,
      question.optionC,
      question.optionD,
    ].map(normalize);
    if (new Set(options).size !== 4) {
      throw new Error('The AI provider generated duplicate answer options.');
    }
  }

  return questions;
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function sampleStudyMaterial(text: string): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  const maxLength = 60000;
  if (normalized.length <= maxLength) return normalized;

  const sectionLength = maxLength / 3;
  const middleStart = Math.max(
    0,
    Math.floor(normalized.length / 2 - sectionLength / 2),
  );
  return [
    normalized.slice(0, sectionLength),
    normalized.slice(middleStart, middleStart + sectionLength),
    normalized.slice(-sectionLength),
  ].join('\n\n[...document section...]\n\n');
}
