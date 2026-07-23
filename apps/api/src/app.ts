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
import { healthController } from '@api/controllers/healthController.js';

export const app = express();

app.disable('x-powered-by');
if (env.TRUST_PROXY_HOPS > 0) app.set('trust proxy', env.TRUST_PROXY_HOPS);

app.use(helmet());
app.use(compression());
app.use(requestLogger);
app.use(
  cors({
    origin(origin, callback) {
      if (!origin || origin === env.WEB_APP_URL) {
        callback(null, true);
        return;
      }
      callback(new AppError('CORS_ORIGIN_DENIED', 'The request origin is not allowed.', 403));
    },
    credentials: true,
  }),
);
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false, limit: '1mb' }));
app.use(cookieParser(env.SESSION_SECRET));

app.get('/', (_request, response) => {
  response.json({
    message: 'MailMind AI API',
    status: 'running',
  });
});

// Backward-compatible unprefixed probes for load balancers and container platforms.
app.get('/health', (request, response) => healthController.getHealth(request, response));
app.get('/ready', (request, response) => void healthController.getReadiness(request, response));

app.use(API_PREFIX, apiRouter);

app.use((_request, _response, next) => {
  next(new AppError('NOT_FOUND', 'Not found.', 404));
});

app.use(errorHandler);
