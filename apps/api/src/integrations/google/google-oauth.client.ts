import { google } from 'googleapis';

import { env } from '@api/config/env.js';

export type GoogleOAuthPurpose = 'LOGIN' | 'GMAIL';

export function createGoogleOAuthClient(purpose: GoogleOAuthPurpose) {
  return new google.auth.OAuth2(
    env.GOOGLE_CLIENT_ID,
    env.GOOGLE_CLIENT_SECRET,
    purpose === 'LOGIN' ? env.GOOGLE_LOGIN_REDIRECT_URI : env.GOOGLE_GMAIL_REDIRECT_URI,
  );
}
