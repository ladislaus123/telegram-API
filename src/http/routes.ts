import fs from 'node:fs';
import crypto from 'node:crypto';
import express, { Router } from 'express';
import { z } from 'zod';
import { AppConfig } from '../config';
import { MediaStore } from '../media/media-store';
import { SqliteStore } from '../storage/sqlite-store';
import { TelegramSessionManager } from '../telegram/session-manager';
import { WebhookEvent } from '../types';
import { WebhookDispatcher } from '../webhooks/webhook-dispatcher';
import { asyncHandler } from './async-handler';
import { createApiKeyMiddleware } from './auth';
import { HttpError } from './errors';

const webhookEventSchema = z.enum([
  'message.received',
  'message.edited',
  'message.deleted',
  'message.sent',
  'session.status',
  'session.error',
]);

const recipientTargetSchema = z
  .object({
    type: z.enum(['chat_id', 'username', 'phone']),
    value: z.string().trim().min(1),
  })
  .strict();

const sendTextSchema = z
  .object({
    to: recipientTargetSchema,
    text: z.string().trim().min(1),
  })
  .strict();

const sendMediaSchema = z
  .object({
    to: recipientTargetSchema,
    mediaUrl: z.string().url(),
    caption: z.string().optional(),
    fileName: z.string().trim().min(1).optional(),
    type: z.enum(['image', 'audio', 'video', 'file', 'voice']).optional(),
    forceDocument: z.boolean().optional(),
    supportsStreaming: z.boolean().optional(),
  })
  .strict();

const historyQuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(100).default(50),
});

const createWebhookSchema = z
  .object({
    url: z.string().url(),
    events: z.array(webhookEventSchema).min(1),
    secret: z.string().min(1).optional(),
    session: z.string().trim().min(1).nullable().optional(),
  })
  .strict();

const sessionNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .regex(/^[A-Za-z0-9_.-]+$/, 'Use only letters, numbers, ".", "_", and "-".');

const createSessionSchema = z
  .object({
    name: sessionNameSchema,
    apiId: z.coerce.number().int().positive(),
    apiHash: z.string().trim().min(1),
    stringSession: z.string().trim().min(1).optional(),
    start: z.boolean().optional().default(false),
  })
  .strict();

const updateSessionSchema = z
  .object({
    apiId: z.coerce.number().int().positive().optional(),
    apiHash: z.string().trim().min(1).optional(),
    stringSession: z.string().trim().min(1).optional(),
  })
  .strict()
  .refine((payload) => Object.keys(payload).length > 0, {
    message: 'Provide at least one field to update.',
  });

const requestLoginCodeSchema = z
  .object({
    phoneNumber: z.string().trim().min(5),
    forceSMS: z.boolean().optional().default(false),
  })
  .strict();

const confirmLoginSchema = z
  .object({
    code: z.string().trim().min(1).optional(),
    password: z.string().min(1).optional(),
  })
  .strict()
  .refine((payload) => payload.code || payload.password, {
    message: 'Provide a Telegram login code or 2FA password.',
  });

interface RouteDependencies {
  config: AppConfig;
  store: SqliteStore;
  mediaStore: MediaStore;
  sessionManager: TelegramSessionManager;
  webhookDispatcher: WebhookDispatcher;
}

export function createRoutes(dependencies: RouteDependencies): Router {
  const router = Router();

  router.get('/health', (_req, res) => {
    res.status(200).json({ ok: true });
  });

  router.get('/ready', (_req, res) => {
    res.status(200).json({
      ready: true,
      sessions: dependencies.sessionManager.listSessions(),
    });
  });

  const api = Router();
  api.use(createApiKeyMiddleware(dependencies.config));

  api.get('/sessions', (_req, res) => {
    res.status(200).json({ sessions: dependencies.sessionManager.listSessions() });
  });

  api.post(
    '/sessions',
    asyncHandler(async (req, res) => {
      const payload = createSessionSchema.parse(req.body);
      const session = await dependencies.sessionManager.createSession(payload);
      res.status(201).json({ session });
    }),
  );

  api.get('/sessions/:session/status', (req, res) => {
    res.status(200).json({
      session: dependencies.sessionManager.getSessionStatus(readParam(req.params.session)),
    });
  });

  api.post(
    '/sessions/:session/start',
    asyncHandler(async (req, res) => {
      const session = await dependencies.sessionManager.startSession(
        readParam(req.params.session),
        { throwOnAuthRequired: true },
      );
      res.status(200).json({ session });
    }),
  );

  api.post(
    '/sessions/:session/login/code',
    asyncHandler(async (req, res) => {
      const payload = requestLoginCodeSchema.parse(req.body);
      const result = await dependencies.sessionManager.requestLoginCode(
        readParam(req.params.session),
        payload.phoneNumber,
        payload.forceSMS,
      );
      res.status(200).json(result);
    }),
  );

  api.post(
    '/sessions/:session/login/confirm',
    asyncHandler(async (req, res) => {
      const payload = confirmLoginSchema.parse(req.body);
      const result = await dependencies.sessionManager.confirmLogin(
        readParam(req.params.session),
        payload,
      );
      res.status(200).json(result);
    }),
  );

  api.post(
    '/sessions/:session/stop',
    asyncHandler(async (req, res) => {
      const session = await dependencies.sessionManager.stopSession(
        readParam(req.params.session),
      );
      res.status(200).json({ session });
    }),
  );

  api.patch(
    '/sessions/:session',
    asyncHandler(async (req, res) => {
      const payload = updateSessionSchema.parse(req.body);
      const session = await dependencies.sessionManager.updateSession(
        readParam(req.params.session),
        payload,
      );
      res.status(200).json({ session });
    }),
  );

  api.delete(
    '/sessions/:session',
    asyncHandler(async (req, res) => {
      await dependencies.sessionManager.deleteSession(readParam(req.params.session));
      res.status(200).json({ success: true });
    }),
  );

  api.post(
    '/sessions/:session/messages/text',
    asyncHandler(async (req, res) => {
      const payload = sendTextSchema.parse(req.body);
      const result = await dependencies.sessionManager.sendText(
        readParam(req.params.session),
        payload.to,
        payload.text,
      );
      res.status(200).json(result);
    }),
  );

  api.post(
    '/sessions/:session/messages/media',
    asyncHandler(async (req, res) => {
      const payload = sendMediaSchema.parse(req.body);
      const result = await dependencies.sessionManager.sendMedia(
        readParam(req.params.session),
        payload.to,
        payload.mediaUrl,
        {
          caption: payload.caption,
          fileName: payload.fileName,
          type: payload.type,
          forceDocument: payload.forceDocument,
          supportsStreaming: payload.supportsStreaming,
        },
      );
      res.status(200).json(result);
    }),
  );

  api.get(
    '/sessions/:session/chats/:chatId/messages',
    asyncHandler(async (req, res) => {
      const query = historyQuerySchema.parse(req.query);
      const messages = await dependencies.sessionManager.listMessages(
        readParam(req.params.session),
        readParam(req.params.chatId),
        query.limit,
      );
      res.status(200).json({ messages });
    }),
  );

  api.get('/media/:mediaId', (req, res) => {
    const media = dependencies.mediaStore.getMedia(readParam(req.params.mediaId));
    if (!media || !fs.existsSync(media.filePath)) {
      throw new HttpError(404, 'Media not found.');
    }

    if (media.mimeType) {
      res.type(media.mimeType);
    }
    if (media.fileName) {
      res.attachment(media.fileName);
    }
    res.sendFile(media.filePath);
  });

  api.get('/webhooks', (_req, res) => {
    res.status(200).json({ webhooks: dependencies.store.listWebhooks() });
  });

  api.post('/webhooks', (req, res) => {
    const payload = createWebhookSchema.parse(req.body);
    const webhook = dependencies.store.createWebhook({
      id: cryptoRandomId(),
      url: payload.url,
      events: payload.events as WebhookEvent[],
      secret: payload.secret ?? dependencies.config.defaultWebhookSecret,
      session: payload.session ?? null,
    });
    res.status(201).json({ webhook });
  });

  api.delete('/webhooks/:id', (req, res) => {
    const deleted = dependencies.store.deleteWebhook(readParam(req.params.id));
    if (!deleted) {
      throw new HttpError(404, 'Webhook not found.');
    }
    res.status(200).json({ success: true });
  });

  api.post(
    '/webhooks/:id/test',
    asyncHandler(async (req, res) => {
      const webhook = dependencies.store.getWebhook(readParam(req.params.id));
      if (!webhook) {
        throw new HttpError(404, 'Webhook not found.');
      }
      await dependencies.webhookDispatcher.dispatchTest(webhook);
      res.status(200).json({ success: true });
    }),
  );

  router.use('/api', api);
  router.use(express.static('public'));

  return router;
}

function cryptoRandomId(): string {
  return crypto.randomUUID();
}

function readParam(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value[0] : (value ?? '');
}
