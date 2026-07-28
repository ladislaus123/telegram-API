import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { TelegramClient } from 'telegram';
import { Api } from 'telegram/tl';
import { AppConfig } from '../config';
import { SqliteStore } from '../storage/sqlite-store';
import { MediaRecord, TelegramMessageMediaPayload } from '../types';

type TelegramMessageWithHelpers = Api.Message & {
  file?: {
    name?: string;
    mimeType?: string;
    size?: number | bigint | { toString(): string };
  };
};

export class MediaStore {
  constructor(
    private readonly store: SqliteStore,
    private readonly config: Pick<AppConfig, 'mediaStorageDir' | 'publicBaseUrl'>,
  ) {
    fs.mkdirSync(config.mediaStorageDir, { recursive: true });
  }

  getMedia(id: string): MediaRecord | null {
    return this.store.getMedia(id);
  }

  async storeIncomingMedia(
    session: string,
    message: TelegramMessageWithHelpers,
    client: TelegramClient,
  ): Promise<TelegramMessageMediaPayload | null> {
    if (!message.media) {
      return null;
    }

    const downloaded = await client.downloadMedia(message, {});
    if (!Buffer.isBuffer(downloaded) || downloaded.length === 0) {
      return null;
    }

    const mimeType = this.resolveMimeType(message);
    const fileName = this.resolveFileName(message, mimeType);
    const id = crypto.randomUUID();
    const extension = this.extensionFromFileName(fileName) || this.extensionFromMimeType(mimeType);
    const storageName = extension ? `${id}.${extension}` : id;
    const filePath = path.join(this.config.mediaStorageDir, storageName);

    fs.writeFileSync(filePath, downloaded);

    const record = this.store.createMedia({
      id,
      session,
      messageId: String(message.id),
      filePath,
      fileName,
      mimeType,
      size: downloaded.length,
      createdAt: new Date().toISOString(),
    });

    return {
      id: record.id,
      mimeType: record.mimeType,
      fileName: record.fileName,
      size: record.size,
      downloadUrl: `${this.config.publicBaseUrl}/api/media/${record.id}`,
    };
  }

  private resolveMimeType(message: TelegramMessageWithHelpers): string | null {
    if (message.photo) {
      return 'image/jpeg';
    }
    return message.file?.mimeType ?? message.document?.mimeType ?? null;
  }

  private resolveFileName(
    message: TelegramMessageWithHelpers,
    mimeType: string | null,
  ): string {
    const rawName = message.file?.name?.trim();
    if (rawName) {
      return path.basename(rawName);
    }

    const extension = this.extensionFromMimeType(mimeType);
    return extension ? `telegram-${message.id}.${extension}` : `telegram-${message.id}`;
  }

  private extensionFromFileName(fileName: string): string | null {
    const ext = path.extname(fileName).replace(/^\./, '').trim();
    return ext || null;
  }

  private extensionFromMimeType(mimeType: string | null): string | null {
    if (!mimeType) {
      return null;
    }

    const map: Record<string, string> = {
      'image/jpeg': 'jpg',
      'image/png': 'png',
      'image/webp': 'webp',
      'image/gif': 'gif',
      'video/mp4': 'mp4',
      'audio/mpeg': 'mp3',
      'audio/ogg': 'ogg',
      'application/pdf': 'pdf',
    };

    return map[mimeType] ?? null;
  }
}
