import compression from 'compression';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import express from 'express';
import helmet from 'helmet';

import { env } from '@api/config/env.js';
import { AppError } from '@api/errors/AppError.js';
import { errorHandler } from '@api/middleware/errorHandler.js';
import { requestLogger } from '@api/middleware/requestLogger.js';
import { apiRouter } from '@api/routes/index.js';
import { API_PREFIX } from '@mailmind/shared';

export const app = express();

app.disable('x-powered-by');
if (env.TRUST_PROXY_HOPS > 0) app.set('trust proxy', env.TRUST_PROXY_HOPS);

app.use(helmet());
app.use(compression());
app.use(
  cors({
    origin(origin, callback) {
      callback(null, !origin || origin === env.WEB_APP_URL);
    },
    credentials: true,
  }),
);
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false, limit: '1mb' }));
app.use(cookieParser(env.SESSION_SECRET));
app.use(requestLogger);

app.get('/', (_request, response) => {
  response.json({
    message: 'MailMind AI API',
    status: 'running',
  });
});

app.use(API_PREFIX, apiRouter);

app.use((_request, _response, next) => {
  next(new AppError('NOT_FOUND', 'Not found.', 404));
});

app.use(errorHandler);
