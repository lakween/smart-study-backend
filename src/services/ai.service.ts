import { GoogleGenerativeAI } from '@google/generative-ai';
import { env } from '../config/env';

export interface GeneratedQuestion {
  text: string;
  optionA: string;
  optionB: string;
  optionC: string;
  optionD: string;
  correctAnswer: 'A' | 'B' | 'C' | 'D';
  explanation: string;
}

const client = env.geminiApiKey ? new GoogleGenerativeAI(env.geminiApiKey) : null;

export async function generateQuizQuestions(params: {
  questionCount: number;
  text?: string;
  imageBuffer?: Buffer;
  imageMimeType?: string;
}): Promise<GeneratedQuestion[]> {
  if (!client) {
    throw new Error(
      'GEMINI_API_KEY is not configured on the server. Add it to backend/.env to enable AI quiz generation.'
    );
  }

  const model = client.getGenerativeModel({
    model: 'gemini-1.5-flash',
    generationConfig: { responseMimeType: 'application/json' },
  });

  const instruction = `You are an expert teacher creating a multiple-choice quiz from study material.
Generate exactly ${params.questionCount} multiple-choice questions based on the provided content.
Each question must have exactly 4 options (A, B, C, D), exactly one correct answer, and a short explanation of why it is correct.
Vary difficulty and avoid duplicate questions.
Return ONLY a JSON array (no markdown fences, no surrounding text) where each item has this exact shape:
{"text": string, "optionA": string, "optionB": string, "optionC": string, "optionD": string, "correctAnswer": "A"|"B"|"C"|"D", "explanation": string}`;

  const parts: Array<Record<string, unknown>> = [{ text: instruction }];
  if (params.text) {
    parts.push({ text: `Study material:\n${params.text.slice(0, 20000)}` });
  }
  if (params.imageBuffer && params.imageMimeType) {
    parts.push({ inlineData: { data: params.imageBuffer.toString('base64'), mimeType: params.imageMimeType } });
  }

  const result = await model.generateContent(parts as never);
  const raw = result.response.text();

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('AI returned a response that could not be parsed as JSON. Please try again.');
  }

  const questions = Array.isArray(parsed) ? parsed : (parsed as { questions?: unknown })?.questions;
  if (!Array.isArray(questions) || questions.length === 0) {
    throw new Error('AI response did not contain any questions.');
  }

  return questions.map((q: any) => ({
    text: String(q.text ?? '').trim(),
    optionA: String(q.optionA ?? '').trim(),
    optionB: String(q.optionB ?? '').trim(),
    optionC: String(q.optionC ?? '').trim(),
    optionD: String(q.optionD ?? '').trim(),
    correctAnswer: ['A', 'B', 'C', 'D'].includes(String(q.correctAnswer ?? '').toUpperCase())
      ? (String(q.correctAnswer).toUpperCase() as 'A' | 'B' | 'C' | 'D')
      : 'A',
    explanation: String(q.explanation ?? '').trim(),
  }));
}
