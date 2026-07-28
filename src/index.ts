import http from 'node:http';
import pino from 'pino';
import { appConfig } from './config';
import { createApp } from './app';
import { MediaStore } from './media/media-store';
import { SqliteStore } from './storage/sqlite-store';
import { TelegramSessionManager } from './telegram/session-manager';
import { WebhookDispatcher } from './webhooks/webhook-dispatcher';

const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
});

async function main(): Promise<void> {
  const store = new SqliteStore(appConfig.sqlitePath);
  const webhookDispatcher = new WebhookDispatcher(store, appConfig, logger);
  const mediaStore = new MediaStore(store, appConfig);
  const sessionManager = new TelegramSessionManager(
    store,
    mediaStore,
    webhookDispatcher,
    appConfig,
    logger,
  );

  const app = createApp({
    config: appConfig,
    logger,
    store,
    mediaStore,
    webhookDispatcher,
    sessionManager,
  });

  await sessionManager.boot();

  const server = http.createServer(app);
  server.listen(appConfig.port, appConfig.host, () => {
    logger.info(
      {
        host: appConfig.host,
        port: appConfig.port,
        publicBaseUrl: appConfig.publicBaseUrl,
        sqlitePath: appConfig.sqlitePath,
      },
      'Telegram connector service started',
    );
  });

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutting down Telegram connector service');
    server.close(async () => {
      await sessionManager.stopAll();
      store.close();
      process.exit(0);
    });
  };

  process.on('SIGTERM', () => {
    void shutdown('SIGTERM');
  });
  process.on('SIGINT', () => {
    void shutdown('SIGINT');
  });
}

void main().catch((error) => {
  logger.fatal({ err: error }, 'Telegram connector service failed to start');
  process.exit(1);
});
