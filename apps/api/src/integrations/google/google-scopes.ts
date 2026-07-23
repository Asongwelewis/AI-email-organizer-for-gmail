export const GOOGLE_LOGIN_SCOPES = ['openid', 'email', 'profile'] as const;
export const GMAIL_MODIFY_SCOPE = 'https://www.googleapis.com/auth/gmail.modify';
export const GOOGLE_GMAIL_SCOPES = [...GOOGLE_LOGIN_SCOPES, GMAIL_MODIFY_SCOPE] as const;
