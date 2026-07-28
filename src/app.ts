import express from 'express';
import pinoHttp from 'pino-http';
import { AppConfig } from './config';
import { errorHandler } from './http/error-handler';
import { createRoutes } from './http/routes';
import { MediaStore } from './media/media-store';
import { SqliteStore } from './storage/sqlite-store';
import { TelegramSessionManager } from './telegram/session-manager';
import { WebhookDispatcher } from './webhooks/webhook-dispatcher';
import { Logger } from 'pino';

export interface AppDependencies {
  config: AppConfig;
  logger: Logger;
  store: SqliteStore;
  mediaStore: MediaStore;
  webhookDispatcher: WebhookDispatcher;
  sessionManager: TelegramSessionManager;
}

export function createApp(dependencies: AppDependencies) {
  const app = express();

  app.use(pinoHttp({ logger: dependencies.logger }));
  app.use(express.json({ limit: '10mb' }));
  app.use(express.urlencoded({ extended: true }));
  app.use(createRoutes(dependencies));
  app.use(errorHandler);

  return app;
}
