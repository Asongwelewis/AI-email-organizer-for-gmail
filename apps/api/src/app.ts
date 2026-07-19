import compression from 'compression';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';

import { env } from '@api/config/env.js';
import { errorHandler } from '@api/middleware/errorHandler.js';
import { requestLogger } from '@api/middleware/requestLogger.js';
import { apiRouter } from '@api/routes/index.js';
import { API_PREFIX } from '@mailmind/shared';

export const app = express();

app.disable('x-powered-by');

app.use(helmet());
app.use(compression());
app.use(
  cors({
    origin: env.WEB_URL,
    credentials: true,
  }),
);
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser(env.SESSION_SECRET));
app.use(requestLogger);
app.use(
  rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 250,
    standardHeaders: true,
    legacyHeaders: false,
  }),
);

app.get('/', (_request, response) => {
  response.json({
    message: 'MailMind AI API',
    status: 'running',
  });
});

app.use(API_PREFIX, apiRouter);

app.use((_request, _response, next) => {
  next(new Error('Not Found'));
});

app.use(errorHandler);
