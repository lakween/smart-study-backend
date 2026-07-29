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

function positiveNumber(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive number`);
  }
  return value;
}

const nodeEnv = process.env.NODE_ENV ?? 'development';
const corsOrigin = process.env.CORS_ORIGIN ?? '*';
const jwtSecret = required('JWT_SECRET');
if (nodeEnv === 'production' && corsOrigin.trim() === '*') {
  throw new Error('CORS_ORIGIN must list explicit origins in production');
}
if (nodeEnv === 'production' && jwtSecret.length < 32) {
  throw new Error('JWT_SECRET must contain at least 32 characters in production');
}

export const env = {
  nodeEnv,
  isProduction: nodeEnv === 'production',
  port: positiveNumber('PORT', 4000),
  databaseUrl: required('DATABASE_URL'),
  jwtSecret,
  jwtExpiresIn: process.env.JWT_EXPIRES_IN ?? '15m',
  refreshTokenExpiresDays: positiveNumber('REFRESH_TOKEN_EXPIRES_DAYS', 30),
  aiProvider: aiProvider(process.env.AI_PROVIDER),
  openAiApiKey: process.env.OPENAI_API_KEY ?? '',
  openAiModel: process.env.OPENAI_MODEL ?? 'gpt-5.6-terra',
  geminiApiKey: process.env.GEMINI_API_KEY ?? '',
  geminiModel: process.env.GEMINI_MODEL ?? 'gemini-3.6-flash',
  corsOrigin,
  publicBaseUrl: process.env.PUBLIC_BASE_URL ?? 'http://localhost:4000',
  passwordResetTtlMinutes: positiveNumber('PASSWORD_RESET_TTL_MINUTES', 30),
  trustProxy: process.env.TRUST_PROXY === 'true',
};
