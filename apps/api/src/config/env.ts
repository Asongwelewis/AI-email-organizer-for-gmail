import 'dotenv/config';

import { z } from 'zod';

const environmentSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  API_BASE_URL: z.string().url().default('http://localhost:4000'),
  WEB_URL: z.string().url().default('http://localhost:5173'),
  DATABASE_URL: z
    .string()
    .min(1)
    .default('postgresql://postgres:postgres@localhost:5432/mailmind_ai'),
  DIRECT_URL: z.string().min(1).optional(),
  SUPABASE_URL: z.string().url().optional(),
  SUPABASE_PUBLISHABLE_KEY: z.string().min(1).optional(),
  SUPABASE_SECRET_KEY: z.string().min(1).optional(),
  JWT_SECRET: z.string().min(1).default('replace-with-a-long-random-secret'),
  SESSION_SECRET: z.string().min(1).default('replace-with-a-long-random-secret'),
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  GOOGLE_LOGIN_REDIRECT_URI: z
    .string()
    .url()
    .default('http://localhost:4000/api/auth/google/callback'),
  GOOGLE_GMAIL_REDIRECT_URI: z
    .string()
    .url()
    .default('http://localhost:4000/api/integrations/google/callback'),
  OPENAI_API_KEY: z.string().optional(),
  LLM_MODEL: z.string().default('gpt-5.4-mini'),
});

export const env = environmentSchema.parse(process.env);
