import { execFile } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import bigInt from 'big-integer';
import { Logger } from 'pino';
import { TelegramClient, Api } from 'telegram';
import { CustomFile } from 'telegram/client/uploads';
import { NewMessage } from 'telegram/events';
import { DeletedMessage } from 'telegram/events/DeletedMessage';
import { EditedMessage } from 'telegram/events/EditedMessage';
import { StringSession } from 'telegram/sessions';
import type { EntityLike } from 'telegram/define';
import { AppConfig } from '../config';
import { HttpError } from '../http/errors';
import { MediaStore } from '../media/media-store';
import {
  CreateSessionInput,
  SqliteStore,
  UpdateSessionInput,
} from '../storage/sqlite-store';
import {
  PublicSessionRecord,
  RecipientTarget,
  SendMessageResult,
  SessionStatus,
  TelegramConnectorEvent,
  TelegramMessagePayload,
} from '../types';
import { WebhookDispatcher } from '../webhooks/webhook-dispatcher';
import { normalizeTelegramMessage } from './message-normalizer';

interface ManagedClient {
  name: string;
  client: TelegramClient;
}

interface PendingLogin {
  client: TelegramClient;
  phoneNumber: string;
  phoneCodeHash: string;
  apiId: number;
  apiHash: string;
  isCodeViaApp: boolean;
  needsPassword: boolean;
  expiresAt: number;
}

type OutboundMediaType = 'image' | 'audio' | 'video' | 'file' | 'voice';

interface SendMediaInput {
  caption?: string;
  fileName?: string;
  type?: OutboundMediaType;
  forceDocument?: boolean;
  supportsStreaming?: boolean;
}

interface PreparedOutboundMedia {
  file: CustomFile;
  mediaUrl: string;
  fileName: string;
  mimeType: string | null;
  tempDir: string | null;
  cleanup: () => Promise<void>;
}

interface MediaFileForUpload {
  file: CustomFile;
  fileName: string;
  voiceNote: boolean;
  cleanup: () => Promise<void>;
}

interface ResolvedRecipient {
  entity: EntityLike;
  chatIdFallback: string;
}

export type TelegramClientFactory = (params: {
  stringSession: string;
  apiId: number;
  apiHash: string;
}) => TelegramClient;

const LOGIN_TTL_MS = 10 * 60 * 1000;
const OUTBOUND_MEDIA_DOWNLOAD_TIMEOUT_MS = 2 * 60 * 1000;
const OUTBOUND_MEDIA_CONVERSION_TIMEOUT_MS = 2 * 60 * 1000;
const execFileAsync = promisify(execFile);

const MIME_EXTENSION_MAP: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'video/ogg': 'ogv',
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'audio/aac': 'aac',
  'audio/flac': 'flac',
  'audio/ogg': 'ogg',
  'audio/opus': 'opus',
  'audio/wav': 'wav',
  'audio/x-m4a': 'm4a',
  'audio/webm': 'webm',
  'application/pdf': 'pdf',
};

const AUDIO_FILE_EXTENSIONS = new Set([
  '.aac',
  '.amr',
  '.flac',
  '.m4a',
  '.mp3',
  '.oga',
  '.ogg',
  '.opus',
  '.wav',
  '.weba',
  '.webm',
]);

export class TelegramSessionManager {
  private readonly clients = new Map<string, ManagedClient>();
  private readonly pendingLogins = new Map<string, PendingLogin>();

  constructor(
    private readonly store: SqliteStore,
    private readonly mediaStore: MediaStore,
    private readonly webhookDispatcher: WebhookDispatcher,
    private readonly config: Pick<AppConfig, 'telegram'> &
      Partial<Pick<AppConfig, 'publicBaseUrl'>>,
    private readonly logger: Logger,
    private readonly clientFactory: TelegramClientFactory = ({
      stringSession,
      apiId,
      apiHash,
    }) =>
      new TelegramClient(new StringSession(stringSession), apiId, apiHash, {
        connectionRetries: 5,
      }),
  ) {}

  async boot(): Promise<void> {
    if (this.config.telegram.apiId && this.config.telegram.apiHash) {
      this.store.ensureSession({
        name: this.config.telegram.defaultSession,
        apiId: this.config.telegram.apiId,
        apiHash: this.config.telegram.apiHash,
        stringSession: this.config.telegram.initialStringSession,
      });
    }

    for (const session of this.store.listSessions()) {
      if (session.stringSession) {
        try {
          await this.startSession(session.name, { throwOnAuthRequired: false });
        } catch (error) {
          this.logger.warn(
            { err: error, session: session.name },
            'Telegram session failed to boot; service will continue',
          );
        }
      } else {
        this.setSessionStatus(session.name, 'auth_required');
      }
    }
  }

  listSessions(): PublicSessionRecord[] {
    return this.store.listSessions().map(toPublicSession);
  }

  getSessionStatus(name: string): PublicSessionRecord {
    const session = this.store.getSession(name);
    if (!session) {
      throw new HttpError(404, 'Session not found.');
    }
    return toPublicSession(session);
  }

  async createSession(
    input: CreateSessionInput & { start?: boolean },
  ): Promise<PublicSessionRecord> {
    if (this.store.getSession(input.name)) {
      throw new HttpError(409, 'Session name already exists.');
    }
    if (input.start && !input.stringSession) {
      throw new HttpError(
        400,
        'start=true requires an existing GramJS StringSession. Use /login/code for phone login.',
      );
    }

    const session = this.store.createSession(input);
    if (input.start) {
      return this.startSession(session.name, { throwOnAuthRequired: true });
    }

    return toPublicSession(session);
  }

  async requestLoginCode(
    name: string,
    phoneNumber: string,
    forceSMS = false,
  ): Promise<{
    login: {
      status: 'code_sent';
      session: string;
      isCodeViaApp: boolean;
      expiresAt: string;
    };
    session: PublicSessionRecord;
  }> {
    const session = this.store.getSession(name);
    if (!session) {
      throw new HttpError(404, 'Session not found.');
    }
    if (!session.apiId || !session.apiHash) {
      throw new HttpError(409, 'Session requires apiId and apiHash.');
    }
    if (this.clients.get(name)?.client.connected) {
      throw new HttpError(409, 'Session is already connected.');
    }

    await this.clearPendingLogin(name);
    this.setSessionStatus(name, 'starting');

    let client: TelegramClient | null = null;
    try {
      client = this.clientFactory({
        stringSession: '',
        apiId: session.apiId,
        apiHash: session.apiHash,
      });
      await client.connect();
      const sentCode = await client.sendCode(
        { apiId: session.apiId, apiHash: session.apiHash },
        phoneNumber,
        forceSMS,
      );
      const expiresAt = Date.now() + LOGIN_TTL_MS;

      this.pendingLogins.set(name, {
        client,
        phoneNumber,
        phoneCodeHash: sentCode.phoneCodeHash,
        apiId: session.apiId,
        apiHash: session.apiHash,
        isCodeViaApp: sentCode.isCodeViaApp,
        needsPassword: false,
        expiresAt,
      });
      this.setSessionStatus(name, 'auth_required', 'Telegram login code sent.');

      return {
        login: {
          status: 'code_sent',
          session: name,
          isCodeViaApp: sentCode.isCodeViaApp,
          expiresAt: new Date(expiresAt).toISOString(),
        },
        session: this.getSessionStatus(name),
      };
    } catch (error) {
      await client?.disconnect().catch(() => undefined);
      const message = error instanceof Error ? error.message : String(error);
      this.setSessionStatus(name, 'error', message);
      this.logger.error({ err: error, session: name }, 'Telegram login code failed');
      throw toTelegramLoginHttpError(error, 'Failed to request Telegram login code.');
    }
  }

  async confirmLogin(
    name: string,
    input: { code?: string; password?: string },
  ): Promise<{
    login: {
      status: 'connected' | 'password_required';
      session: string;
    };
    session: PublicSessionRecord;
  }> {
    const pending = this.getPendingLogin(name);
    const session = this.store.getSession(name);
    if (!session) {
      await this.clearPendingLogin(name);
      throw new HttpError(404, 'Session not found.');
    }

    try {
      if (!pending.needsPassword) {
        if (!input.code) {
          throw new HttpError(400, 'Telegram login code is required.');
        }

        await this.signInWithCode(name, pending, input.code);
      }

      if (pending.needsPassword) {
        if (!input.password) {
          this.setSessionStatus(name, 'auth_required', 'Telegram 2FA password required.');
          return {
            login: {
              status: 'password_required',
              session: name,
            },
            session: this.getSessionStatus(name),
          };
        }

        await pending.client.signInWithPassword(
          { apiId: pending.apiId, apiHash: pending.apiHash },
          {
            password: async () => input.password ?? '',
            onError: async (error) => {
              throw error;
            },
          },
        );
      }

      await this.finishPendingLogin(name, pending);
      return {
        login: {
          status: 'connected',
          session: name,
        },
        session: this.getSessionStatus(name),
      };
    } catch (error) {
      if (error instanceof HttpError) {
        throw error;
      }

      const rpcError = readRpcErrorMessage(error);
      if (rpcError === 'SESSION_PASSWORD_NEEDED') {
        pending.needsPassword = true;
        this.setSessionStatus(name, 'auth_required', 'Telegram 2FA password required.');
        return {
          login: {
            status: 'password_required',
            session: name,
          },
          session: this.getSessionStatus(name),
        };
      }

      const message = error instanceof Error ? error.message : String(error);
      this.setSessionStatus(name, 'error', message);
      this.logger.error({ err: error, session: name }, 'Telegram login confirm failed');
      throw toTelegramLoginHttpError(error, 'Failed to confirm Telegram login.');
    }
  }

  async updateSession(
    name: string,
    input: UpdateSessionInput,
  ): Promise<PublicSessionRecord> {
    if (!this.store.getSession(name)) {
      throw new HttpError(404, 'Session not found.');
    }

    await this.clearPendingLogin(name);
    const wasConnected = Boolean(this.clients.get(name)?.client.connected);
    if (wasConnected) {
      await this.stopSession(name);
    }

    const session = this.store.updateSession(name, input);
    this.setSessionStatus(name, 'disconnected');

    if (wasConnected) {
      return this.startSession(name, { throwOnAuthRequired: false });
    }

    return toPublicSession(session);
  }

  async deleteSession(name: string): Promise<void> {
    if (!this.store.getSession(name)) {
      throw new HttpError(404, 'Session not found.');
    }

    await this.clearPendingLogin(name);
    await this.stopSession(name).catch(() => undefined);
    const deleted = this.store.deleteSession(name);
    if (!deleted) {
      throw new HttpError(404, 'Session not found.');
    }
  }

  async startSession(
    name: string,
    options: { throwOnAuthRequired?: boolean } = {},
  ): Promise<PublicSessionRecord> {
    const session = this.store.getSession(name);
    if (!session) {
      throw new HttpError(404, 'Session not found.');
    }

    if (!session.apiId || !session.apiHash || !session.stringSession) {
      this.setSessionStatus(name, 'auth_required');
      if (options.throwOnAuthRequired) {
        throw new HttpError(
          409,
          'Session requires apiId, apiHash, and Telegram authentication.',
        );
      }
      return this.getSessionStatus(name);
    }

    const existing = this.clients.get(name);
    if (existing?.client.connected) {
      return this.getSessionStatus(name);
    }

    this.setSessionStatus(name, 'starting');

    let client: TelegramClient | null = null;

    try {
      client = this.clientFactory({
        stringSession: session.stringSession,
        apiId: session.apiId,
        apiHash: session.apiHash,
      });
      await client.connect();
      const authorized = await client.checkAuthorization();
      if (!authorized) {
        await client.disconnect();
        this.setSessionStatus(name, 'auth_required');
        if (options.throwOnAuthRequired) {
          throw new HttpError(409, 'Session requires Telegram authentication.');
        }
        return this.getSessionStatus(name);
      }

      this.registerEventHandlers(name, client);
      this.clients.set(name, { name, client });
      this.store.updateSessionStringSession(
        name,
        (client.session as StringSession).save(),
      );
      this.setSessionStatus(name, 'connected');
      this.logger.info({ session: name }, 'Telegram session connected');
      return this.getSessionStatus(name);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.setSessionStatus(name, 'error', message);
      await client?.disconnect().catch(() => undefined);
      this.logger.error({ err: error, session: name }, 'Telegram session start failed');
      if (error instanceof HttpError) {
        throw error;
      }
      if (isInvalidStringSessionError(error)) {
        throw new HttpError(
          400,
          'Invalid GramJS StringSession.',
          'Generate a real StringSession for this Telegram account and paste the full session string.',
        );
      }
      throw new HttpError(502, 'Failed to start Telegram session.', message);
    }
  }

  async stopSession(name: string): Promise<PublicSessionRecord> {
    await this.clearPendingLogin(name);
    const managed = this.clients.get(name);
    if (managed) {
      await managed.client.disconnect();
      this.clients.delete(name);
    }
    this.setSessionStatus(name, 'disconnected');
    return this.getSessionStatus(name);
  }

  async stopAll(): Promise<void> {
    await Promise.all(
      [...this.clients.keys()].map((name) =>
        this.stopSession(name).catch((error) => {
          this.logger.warn({ error, session: name }, 'Failed to stop session');
        }),
      ),
    );
  }

  async sendText(
    sessionName: string,
    target: RecipientTarget,
    text: string,
  ): Promise<SendMessageResult> {
    const client = this.getConnectedClient(sessionName);
    const recipient = await this.resolveRecipient(client, target);
    const sent = await client.sendMessage(recipient.entity, { message: text });
    const result = this.toSendResult(sessionName, target, recipient, sent);

    this.webhookDispatcher.dispatch({
      provider: 'telegram',
      event: 'message.sent',
      session: sessionName,
      timestamp: new Date().toISOString(),
      payload: result.message,
    });

    return result;
  }

  async sendMedia(
    sessionName: string,
    target: RecipientTarget,
    mediaUrl: string,
    input: SendMediaInput = {},
  ): Promise<SendMessageResult> {
    const client = this.getConnectedClient(sessionName);
    const recipient = await this.resolveRecipient(client, target);
    const prepared = await this.prepareOutboundMedia(mediaUrl, input.fileName);
    const upload = await this.prepareMediaFileForUpload(prepared, input);

    let sent: Api.Message;
    try {
      sent = await client.sendFile(recipient.entity, {
        file: upload.file,
        caption: input.caption,
        forceDocument: upload.voiceNote ? false : input.forceDocument ?? input.type === 'file',
        voiceNote: upload.voiceNote,
        supportsStreaming: input.supportsStreaming ?? input.type === 'video',
      });
    } catch (error) {
      throw toTelegramSendHttpError(error, 'Failed to send Telegram media.');
    } finally {
      await upload.cleanup();
      await prepared.cleanup();
    }

    const result = this.toSendResult(sessionName, target, recipient, sent);

    this.webhookDispatcher.dispatch({
      provider: 'telegram',
      event: 'message.sent',
      session: sessionName,
      timestamp: new Date().toISOString(),
      payload: {
        ...result.message,
        mediaUrl: prepared.mediaUrl,
        fileName: upload.fileName,
        type: input.type ?? null,
      },
    });

    return result;
  }

  private async prepareOutboundMedia(
    mediaUrl: string,
    requestedFileName?: string,
  ): Promise<PreparedOutboundMedia> {
    const storedMedia = this.resolveStoredMedia(mediaUrl);
    if (storedMedia) {
      const stat = await fs.stat(storedMedia.filePath).catch(() => null);
      if (!stat?.isFile()) {
        throw new HttpError(404, 'Stored media file not found.');
      }

      const fileName = resolveOutboundFileName({
        requestedFileName,
        storedFileName: storedMedia.fileName,
        fallbackPath: storedMedia.filePath,
        mimeType: storedMedia.mimeType,
      });

      return {
        file: new CustomFile(fileName, stat.size, storedMedia.filePath),
        mediaUrl,
        fileName,
        mimeType: storedMedia.mimeType,
        tempDir: null,
        cleanup: async () => undefined,
      };
    }

    return this.downloadOutboundMedia(mediaUrl, requestedFileName);
  }

  private resolveStoredMedia(mediaUrl: string) {
    let url: URL;
    try {
      url = new URL(mediaUrl);
    } catch {
      return null;
    }

    const match = /^\/api\/media\/([^/]+)$/.exec(url.pathname);
    if (!match || !isConnectorOrigin(url, this.config.publicBaseUrl)) {
      return null;
    }

    return this.mediaStore.getMedia(decodeURIComponent(match[1]));
  }

  private async downloadOutboundMedia(
    mediaUrl: string,
    requestedFileName?: string,
  ): Promise<PreparedOutboundMedia> {
    let response: Response;
    try {
      response = await fetch(mediaUrl, {
        redirect: 'follow',
        signal: AbortSignal.timeout(OUTBOUND_MEDIA_DOWNLOAD_TIMEOUT_MS),
      });
    } catch (error) {
      const details = error instanceof Error ? error.message : String(error);
      throw new HttpError(400, 'Media URL could not be downloaded.', details);
    }

    if (!response.ok) {
      throw new HttpError(400, 'Media URL could not be downloaded.', {
        status: response.status,
        statusText: response.statusText,
      });
    }

    if (!response.body) {
      throw new HttpError(400, 'Media URL did not return a downloadable body.');
    }

    const mimeType = normalizeContentType(response.headers.get('content-type'));
    const fileName = resolveOutboundFileName({
      requestedFileName,
      contentDisposition: response.headers.get('content-disposition'),
      fallbackUrl: mediaUrl,
      mimeType,
    });
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'telegram-outbound-'));
    const tempPath = path.join(tempDir, fileName);

    try {
      await pipeline(Readable.fromWeb(response.body as any), createWriteStream(tempPath));
      const stat = await fs.stat(tempPath);
      if (!stat.isFile() || stat.size === 0) {
        throw new HttpError(400, 'Media URL returned an empty file.');
      }

      return {
        file: new CustomFile(fileName, stat.size, tempPath),
        mediaUrl,
        fileName,
        mimeType,
        tempDir,
        cleanup: async () => {
          await fs.rm(tempDir, { recursive: true, force: true });
        },
      };
    } catch (error) {
      await fs.rm(tempDir, { recursive: true, force: true });
      if (error instanceof HttpError) {
        throw error;
      }
      const details = error instanceof Error ? error.message : String(error);
      throw new HttpError(400, 'Media URL could not be saved for upload.', details);
    }
  }

  private async prepareMediaFileForUpload(
    prepared: PreparedOutboundMedia,
    input: SendMediaInput,
  ): Promise<MediaFileForUpload> {
    const voiceNote = isAudioOutboundMedia(prepared, input);
    if (!voiceNote) {
      return {
        file: prepared.file,
        fileName: prepared.fileName,
        voiceNote: false,
        cleanup: async () => undefined,
      };
    }

    try {
      return await this.convertAudioToVoiceNote(prepared);
    } catch (error) {
      this.logger.warn(
        {
          err: error,
          mediaUrl: prepared.mediaUrl,
          fileName: prepared.fileName,
          mimeType: prepared.mimeType,
        },
        'Audio conversion failed; sending original media as Telegram voice note',
      );

      return {
        file: prepared.file,
        fileName: prepared.fileName,
        voiceNote: true,
        cleanup: async () => undefined,
      };
    }
  }

  private async convertAudioToVoiceNote(
    prepared: PreparedOutboundMedia,
  ): Promise<MediaFileForUpload> {
    const outputDir =
      prepared.tempDir ?? (await fs.mkdtemp(path.join(os.tmpdir(), 'telegram-voice-')));
    const ownsOutputDir = !prepared.tempDir;
    const outputFileName = toVoiceNoteFileName(prepared.fileName);
    const outputPath = path.join(outputDir, outputFileName);
    const args = [
      '-y',
      '-i',
      prepared.file.path,
      '-c:a',
      'libopus',
      '-b:a',
      '32k',
      '-ac',
      '1',
      '-ar',
      '48000',
      outputPath,
    ];

    try {
      await execFileAsync(this.config.telegram.ffmpegPath ?? 'ffmpeg', args, {
        timeout: OUTBOUND_MEDIA_CONVERSION_TIMEOUT_MS,
        maxBuffer: 5 * 1024 * 1024,
      });

      const stat = await fs.stat(outputPath);
      if (!stat.isFile() || stat.size === 0) {
        throw new Error('ffmpeg produced an empty output file');
      }

      return {
        file: new CustomFile(outputFileName, stat.size, outputPath),
        fileName: outputFileName,
        voiceNote: true,
        cleanup: async () => {
          if (ownsOutputDir) {
            await fs.rm(outputDir, { recursive: true, force: true });
          }
        },
      };
    } catch (error) {
      if (ownsOutputDir) {
        await fs.rm(outputDir, { recursive: true, force: true });
      } else {
        await fs.rm(outputPath, { force: true });
      }
      throw error;
    }
  }

  async listMessages(
    sessionName: string,
    chatId: string,
    limit: number,
  ): Promise<TelegramMessagePayload[]> {
    const client = this.getConnectedClient(sessionName);
    const recipient = await this.resolveRecipient(client, {
      type: 'chat_id',
      value: chatId,
    });
    const messages = await client.getMessages(recipient.entity, { limit });
    const normalized: TelegramMessagePayload[] = [];

    for (const message of messages) {
      if (message instanceof Api.Message) {
        normalized.push(
          await normalizeTelegramMessage({
            session: sessionName,
            message,
            client,
            downloadMedia: false,
          }),
        );
      }
    }

    return normalized.reverse();
  }

  private getConnectedClient(sessionName: string): TelegramClient {
    const managed = this.clients.get(sessionName);
    if (!managed?.client.connected) {
      throw new HttpError(409, 'Telegram session is not connected.');
    }
    return managed.client;
  }

  private async resolveRecipient(
    client: TelegramClient,
    target: RecipientTarget,
  ): Promise<ResolvedRecipient> {
    const value = target.value.trim();
    if (!value) {
      throw new HttpError(400, 'Recipient value is required.');
    }

    if (target.type === 'phone') {
      return this.resolvePhoneRecipient(client, value);
    }

    if (target.type === 'username') {
      return {
        entity: value.replace(/^@/, ''),
        chatIdFallback: target.value,
      };
    }

    if (/^-?\d+$/.test(value)) {
      const numeric = Number(value);
      return {
        entity: Number.isSafeInteger(numeric) ? numeric : bigInt(value),
        chatIdFallback: target.value,
      };
    }

    return {
      entity: value,
      chatIdFallback: target.value,
    };
  }

  private async resolvePhoneRecipient(
    client: TelegramClient,
    phone: string,
  ): Promise<ResolvedRecipient> {
    const contact = new Api.InputPhoneContact({
      clientId: createPhoneContactClientId(),
      phone,
      firstName: 'Telegram Connector',
      lastName: '',
    });

    let imported: Api.contacts.ImportedContacts;
    try {
      imported = await client.invoke(
        new Api.contacts.ImportContacts({ contacts: [contact] }),
      );
    } catch (error) {
      const rpcError = readRpcErrorMessage(error);
      if (rpcError === 'PHONE_NOT_OCCUPIED') {
        throw new HttpError(
          404,
          'Telegram phone recipient could not be resolved.',
          rpcError,
        );
      }
      if (rpcError === 'PHONE_NUMBER_INVALID') {
        throw new HttpError(400, 'Telegram rejected the phone number.', rpcError);
      }
      throw error;
    }

    const user = findImportedUser(imported, contact.clientId, phone);
    if (!user?.accessHash) {
      throw new HttpError(404, 'Telegram phone recipient could not be resolved.');
    }

    return {
      entity: new Api.InputPeerUser({
        userId: user.id,
        accessHash: user.accessHash,
      }),
      chatIdFallback: user.id.toString(),
    };
  }

  private registerEventHandlers(sessionName: string, client: TelegramClient): void {
    client.addEventHandler(
      async (event) => {
        const message = event.message;
        const dedupeKey = `${sessionName}:${message.id}`;
        if (this.store.hasProcessedMessage(dedupeKey)) {
          return;
        }
        this.store.markProcessedMessage(dedupeKey);

        const payload = await normalizeTelegramMessage({
          session: sessionName,
          message,
          client,
          mediaStore: this.mediaStore,
          downloadMedia: this.config.telegram.downloadInboundMedia,
        });

        const envelope: TelegramConnectorEvent<TelegramMessagePayload> = {
          provider: 'telegram',
          event: 'message.received',
          session: sessionName,
          timestamp: new Date().toISOString(),
          payload,
        };
        this.webhookDispatcher.dispatch(envelope);
      },
      new NewMessage({ incoming: true }),
    );

    client.addEventHandler(
      async (event) => {
        const payload = await normalizeTelegramMessage({
          session: sessionName,
          message: event.message,
          client,
          mediaStore: this.mediaStore,
          downloadMedia: false,
        });
        this.webhookDispatcher.dispatch({
          provider: 'telegram',
          event: 'message.edited',
          session: sessionName,
          timestamp: new Date().toISOString(),
          payload,
        });
      },
      new EditedMessage({ incoming: true }),
    );

    client.addEventHandler(
      async (event) => {
        this.webhookDispatcher.dispatch({
          provider: 'telegram',
          event: 'message.deleted',
          session: sessionName,
          timestamp: new Date().toISOString(),
          payload: {
            messageIds: event.deletedIds.map(String),
            peer: event.peer ? String(event.peer) : null,
          },
        });
      },
      new DeletedMessage({}),
    );
  }

  private async signInWithCode(
    sessionName: string,
    pending: PendingLogin,
    code: string,
  ): Promise<void> {
    const result = await pending.client.invoke(
      new Api.auth.SignIn({
        phoneNumber: pending.phoneNumber,
        phoneCodeHash: pending.phoneCodeHash,
        phoneCode: code,
      }),
    );

    if (result instanceof Api.auth.AuthorizationSignUpRequired) {
      await this.clearPendingLogin(sessionName);
      this.setSessionStatus(sessionName, 'auth_required', 'Telegram sign-up required.');
      throw new HttpError(
        409,
        'Telegram account sign-up is not supported by this connector.',
      );
    }
  }

  private async finishPendingLogin(
    name: string,
    pending: PendingLogin,
  ): Promise<void> {
    this.registerEventHandlers(name, pending.client);
    this.clients.set(name, { name, client: pending.client });
    this.pendingLogins.delete(name);
    this.store.updateSessionStringSession(
      name,
      (pending.client.session as StringSession).save(),
    );
    this.setSessionStatus(name, 'connected');
    this.logger.info({ session: name }, 'Telegram session authenticated');
  }

  private getPendingLogin(name: string): PendingLogin {
    const pending = this.pendingLogins.get(name);
    if (!pending) {
      throw new HttpError(409, 'No Telegram login is pending for this session.');
    }

    if (pending.expiresAt <= Date.now()) {
      void this.clearPendingLogin(name);
      throw new HttpError(409, 'Telegram login code expired. Request a new code.');
    }

    return pending;
  }

  private async clearPendingLogin(name: string): Promise<void> {
    const pending = this.pendingLogins.get(name);
    if (!pending) {
      return;
    }

    this.pendingLogins.delete(name);
    await pending.client.disconnect().catch(() => undefined);
  }

  private setSessionStatus(
    name: string,
    status: SessionStatus,
    lastError: string | null = null,
  ): void {
    this.store.updateSessionStatus(name, status, lastError);
    this.webhookDispatcher.dispatch({
      provider: 'telegram',
      event: status === 'error' ? 'session.error' : 'session.status',
      session: name,
      timestamp: new Date().toISOString(),
      payload: {
        status,
        error: lastError,
      },
    });
  }

  private toSendResult(
    sessionName: string,
    target: RecipientTarget,
    recipient: ResolvedRecipient,
    message: Api.Message,
  ): SendMessageResult {
    const messageChatId = message.chatId?.toString();
    const chatId = messageChatId ?? recipient.chatIdFallback;

    return {
      message: {
        providerMessageId: String(message.id),
        session: sessionName,
        chatId,
        status: 'sent',
      },
      raw: {
        id: String(message.id),
        chatId: messageChatId ?? (target.type === 'phone' ? chatId : null),
      },
    };
  }
}

function createPhoneContactClientId() {
  return bigInt(Date.now())
    .multiply(1_000_000)
    .add(Math.floor(Math.random() * 1_000_000));
}

function findImportedUser(
  imported: Api.contacts.ImportedContacts,
  clientId: Api.InputPhoneContact['clientId'],
  phone: string,
): Api.User | null {
  const matchingImported = imported.imported.filter(
    (contact) => contact.clientId.toString() === clientId.toString(),
  );
  const importedUserIds = new Set(
    (matchingImported.length ? matchingImported : imported.imported).map((contact) =>
      contact.userId.toString(),
    ),
  );
  const userByImportedId = imported.users.find(
    (user): user is Api.User =>
      user instanceof Api.User && importedUserIds.has(user.id.toString()),
  );
  if (userByImportedId) {
    return userByImportedId;
  }

  const normalizedPhone = normalizePhoneForComparison(phone);
  return (
    imported.users.find(
      (user): user is Api.User =>
        user instanceof Api.User &&
        normalizePhoneForComparison(user.phone ?? '') === normalizedPhone,
    ) ?? null
  );
}

function normalizePhoneForComparison(value: string): string {
  return value.replace(/\D/g, '');
}

function resolveOutboundFileName(input: {
  requestedFileName?: string;
  storedFileName?: string | null;
  contentDisposition?: string | null;
  fallbackUrl?: string;
  fallbackPath?: string;
  mimeType?: string | null;
}): string {
  const rawName =
    sanitizeFileName(input.requestedFileName) ??
    sanitizeFileName(input.storedFileName) ??
    sanitizeFileName(fileNameFromContentDisposition(input.contentDisposition)) ??
    sanitizeFileName(fileNameFromUrl(input.fallbackUrl)) ??
    sanitizeFileName(input.fallbackPath ? path.basename(input.fallbackPath) : null) ??
    'telegram-media';

  if (path.extname(rawName)) {
    return rawName;
  }

  const extension = extensionFromMimeType(input.mimeType);
  return extension ? `${rawName}.${extension}` : rawName;
}

function isAudioOutboundMedia(
  prepared: Pick<PreparedOutboundMedia, 'fileName' | 'mimeType'>,
  input: SendMediaInput,
): boolean {
  if (input.type === 'audio' || input.type === 'voice') {
    return true;
  }

  if (prepared.mimeType?.toLowerCase().startsWith('audio/')) {
    return true;
  }

  return AUDIO_FILE_EXTENSIONS.has(path.extname(prepared.fileName).toLowerCase());
}

function toVoiceNoteFileName(fileName: string): string {
  const extension = path.extname(fileName);
  const basename = extension ? fileName.slice(0, -extension.length) : fileName;
  return `${sanitizeFileName(basename) ?? 'telegram-media'}-voice.ogg`;
}

function isConnectorOrigin(url: URL, publicBaseUrl?: string): boolean {
  if (isLoopbackHost(url.hostname)) {
    return true;
  }

  if (!publicBaseUrl) {
    return false;
  }

  try {
    return url.origin === new URL(publicBaseUrl).origin;
  } catch {
    return false;
  }
}

function isLoopbackHost(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
}

function sanitizeFileName(value?: string | null): string | null {
  if (!value) {
    return null;
  }

  const fileName = path
    .basename(value)
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim();

  return fileName || null;
}

function fileNameFromContentDisposition(value?: string | null): string | null {
  if (!value) {
    return null;
  }

  const encoded = /filename\*=(?:[^']*)''([^;]+)/i.exec(value);
  if (encoded?.[1]) {
    return safeDecodeURIComponent(encoded[1].trim().replace(/^"|"$/g, ''));
  }

  const quoted = /filename="([^"]+)"/i.exec(value);
  if (quoted?.[1]) {
    return quoted[1];
  }

  const plain = /filename=([^;]+)/i.exec(value);
  return plain?.[1]?.trim().replace(/^"|"$/g, '') ?? null;
}

function fileNameFromUrl(value?: string): string | null {
  if (!value) {
    return null;
  }

  try {
    const url = new URL(value);
    return safeDecodeURIComponent(path.basename(url.pathname));
  } catch {
    return null;
  }
}

function safeDecodeURIComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function normalizeContentType(value: string | null): string | null {
  return value?.split(';')[0]?.trim().toLowerCase() || null;
}

function extensionFromMimeType(value?: string | null): string | null {
  if (!value) {
    return null;
  }

  return MIME_EXTENSION_MAP[value] ?? null;
}

function toPublicSession(session: {
  name: string;
  apiId: number;
  stringSession: string;
  status: SessionStatus;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}): PublicSessionRecord {
  return {
    name: session.name,
    apiId: session.apiId > 0 ? session.apiId : null,
    hasStringSession: Boolean(session.stringSession),
    status: session.status,
    lastError: session.lastError,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
  };
}

function isInvalidStringSessionError(error: unknown): boolean {
  return error instanceof Error && error.message === 'Not a valid string';
}

function toTelegramLoginHttpError(error: unknown, fallbackMessage: string): HttpError {
  const rpcError = readRpcErrorMessage(error);
  if (
    rpcError === 'PHONE_CODE_EMPTY' ||
    rpcError === 'PHONE_CODE_EXPIRED' ||
    rpcError === 'PHONE_CODE_HASH_EMPTY' ||
    rpcError === 'PHONE_CODE_INVALID'
  ) {
    return new HttpError(400, 'Invalid or expired Telegram login code.', rpcError);
  }
  if (
    rpcError === 'PHONE_NUMBER_INVALID' ||
    rpcError === 'PHONE_NUMBER_BANNED' ||
    rpcError === 'PHONE_NUMBER_FLOOD'
  ) {
    return new HttpError(400, 'Telegram rejected the phone number.', rpcError);
  }
  if (rpcError === 'PASSWORD_HASH_INVALID') {
    return new HttpError(400, 'Invalid Telegram 2FA password.', rpcError);
  }

  const details = error instanceof Error ? error.message : String(error);
  return new HttpError(502, fallbackMessage, details);
}

function toTelegramSendHttpError(error: unknown, fallbackMessage: string): HttpError {
  const rpcError = readRpcErrorMessage(error);
  if (rpcError === 'WEBPAGE_CURL_FAILED') {
    return new HttpError(
      400,
      'Telegram could not fetch the media URL.',
      'The connector now uploads media itself when possible; if you still see this, check that the media source is a direct downloadable file.',
    );
  }

  const details = rpcError ?? (error instanceof Error ? error.message : String(error));
  return new HttpError(502, fallbackMessage, details);
}

function readRpcErrorMessage(error: unknown): string | undefined {
  if (!error || typeof error !== 'object' || !('errorMessage' in error)) {
    return undefined;
  }

  return String((error as { errorMessage: unknown }).errorMessage);
}
