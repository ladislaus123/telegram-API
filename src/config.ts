import path from 'node:path';
import { config as loadDotenv } from 'dotenv';
import { z } from 'zod';

loadDotenv();

const optionalPositiveInteger = z.preprocess(
  (value) =>
    typeof value === 'string' && value.trim() === '' ? undefined : value,
  z.coerce.number().int().positive().optional(),
);

const envSchema = z.object({
  SERVER_PORT: z.coerce.number().int().positive().default(4020),
  SERVER_HOST: z.string().trim().min(1).default('127.0.0.1'),
  TELEGRAM_CONNECTOR_API_KEY: z.string().min(1).default('dev-telegram-connector-key'),
  WEBHOOK_SIGNING_SECRET: z.string().min(1).default('dev-webhook-secret'),
  TELEGRAM_API_ID: optionalPositiveInteger,
  TELEGRAM_API_HASH: z.string().optional().default(''),
  TELEGRAM_SESSION: z.string().optional().default(''),
  TELEGRAM_DEFAULT_SESSION: z.string().trim().min(1).default('main'),
  TELEGRAM_FFMPEG_PATH: z.string().trim().min(1).default('ffmpeg'),
  PUBLIC_BASE_URL: z.string().url().optional(),
  SQLITE_PATH: z.string().min(1).default('data/telegram-connector.sqlite'),
  MEDIA_STORAGE_DIR: z.string().min(1).default('media'),
  TELEGRAM_DOWNLOAD_INBOUND_MEDIA: z
    .enum(['true', 'false'])
    .default('true')
    .transform((value) => value === 'true'),
  WEBHOOK_MAX_ATTEMPTS: z.coerce.number().int().positive().default(3),
  WEBHOOK_RETRY_BASE_MS: z.coerce.number().int().nonnegative().default(1000),
});

const parsedEnv = envSchema.parse(process.env);

function resolvePath(value: string): string {
  return path.isAbsolute(value) ? value : path.join(process.cwd(), value);
}

export const appConfig = {
  port: parsedEnv.SERVER_PORT,
  host: parsedEnv.SERVER_HOST,
  apiKey: parsedEnv.TELEGRAM_CONNECTOR_API_KEY,
  defaultWebhookSecret: parsedEnv.WEBHOOK_SIGNING_SECRET,
  telegram: {
    apiId: parsedEnv.TELEGRAM_API_ID ?? null,
    apiHash: parsedEnv.TELEGRAM_API_HASH,
    initialStringSession: parsedEnv.TELEGRAM_SESSION,
    defaultSession: parsedEnv.TELEGRAM_DEFAULT_SESSION,
    ffmpegPath: parsedEnv.TELEGRAM_FFMPEG_PATH,
    downloadInboundMedia: parsedEnv.TELEGRAM_DOWNLOAD_INBOUND_MEDIA,
  },
  publicBaseUrl:
    parsedEnv.PUBLIC_BASE_URL?.replace(/\/+$/, '') ??
    `http://${parsedEnv.SERVER_HOST === '0.0.0.0' ? 'localhost' : parsedEnv.SERVER_HOST}:${parsedEnv.SERVER_PORT}`,
  sqlitePath: resolvePath(parsedEnv.SQLITE_PATH),
  mediaStorageDir: resolvePath(parsedEnv.MEDIA_STORAGE_DIR),
  webhooks: {
    maxAttempts: parsedEnv.WEBHOOK_MAX_ATTEMPTS,
    retryBaseMs: parsedEnv.WEBHOOK_RETRY_BASE_MS,
  },
};

export type AppConfig = typeof appConfig;
