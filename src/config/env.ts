import dotenv from 'dotenv';

dotenv.config();

function required(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function aiProvider(value: string | undefined): 'openai' | 'gemini' {
  const normalized = (value ?? 'openai').trim().toLowerCase();
  if (normalized === 'openai' || normalized === 'gemini') return normalized;
  throw new Error('AI_PROVIDER must be either "openai" or "gemini"');
}

export const env = {
  port: Number(process.env.PORT ?? 4000),
  databaseUrl: required('DATABASE_URL'),
  jwtSecret: required('JWT_SECRET'),
  jwtExpiresIn: process.env.JWT_EXPIRES_IN ?? '7d',
  aiProvider: aiProvider(process.env.AI_PROVIDER),
  openAiApiKey: process.env.OPENAI_API_KEY ?? '',
  openAiModel: process.env.OPENAI_MODEL ?? 'gpt-5.6-terra',
  geminiApiKey: process.env.GEMINI_API_KEY ?? '',
  geminiModel: process.env.GEMINI_MODEL ?? 'gemini-3.6-flash',
  corsOrigin: process.env.CORS_ORIGIN ?? '*',
  publicBaseUrl: process.env.PUBLIC_BASE_URL ?? 'http://localhost:4000',
};
