import { env } from '@api/config/env.js';

const deployedWebOrigins = [
  'https://mailmindai.tech',
  'https://www.mailmindai.tech',
  'https://ai-email-organizer-for-gmail-web.vercel.app',
  'https://ai-email-organizer-for-gmail-5863pdgw2-lucky-5c2dbfb8.vercel.app',
] as const;

export const allowedWebOrigins = new Set<string>([env.WEB_APP_URL, ...deployedWebOrigins]);

export function isAllowedWebOrigin(origin: string): boolean {
  return allowedWebOrigins.has(origin);
}
