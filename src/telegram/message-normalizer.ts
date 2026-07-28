import { TelegramClient, Api } from 'telegram';
import { MediaStore } from '../media/media-store';
import { TelegramMessagePayload } from '../types';

type TelegramEntity = {
  id?: unknown;
  username?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  title?: string | null;
  phone?: string | null;
};

type TelegramMessageWithHelpers = Api.Message & {
  chatId?: { toString(): string };
  senderId?: { toString(): string };
  getSender?: () => Promise<unknown>;
  getChat?: () => Promise<unknown>;
};

export interface NormalizeTelegramMessageOptions {
  session: string;
  message: TelegramMessageWithHelpers;
  client: TelegramClient;
  mediaStore?: MediaStore;
  downloadMedia?: boolean;
}

export async function normalizeTelegramMessage({
  session,
  message,
  client,
  mediaStore,
  downloadMedia = false,
}: NormalizeTelegramMessageOptions): Promise<TelegramMessagePayload> {
  const [sender, chat] = await Promise.all([
    readEntity(message.getSender),
    readEntity(message.getChat),
  ]);
  const media =
    downloadMedia && mediaStore
      ? await mediaStore.storeIncomingMedia(session, message, client)
      : null;
  const chatId = readId(message.chatId ?? chat?.id);
  const senderId = readId(message.senderId ?? sender?.id);
  const senderPhone = readPhone(sender);
  const chatPhone =
    readPhone(chat) ?? (chatId && senderId && chatId === senderId ? senderPhone : null);

  return {
    messageId: String(message.id),
    chatId,
    chatPhone,
    senderId,
    senderPhone,
    username: sender?.username ?? null,
    displayName: formatDisplayName(sender),
    fromMe: Boolean(message.out),
    date: toIsoDate(message.date),
    type: resolveMessageType(message),
    text: message.message || message.text || '',
    media,
    raw: {
      id: String(message.id),
      chatId,
      senderId,
      out: Boolean(message.out),
      groupedId: readId(message.groupedId),
    },
  };
}

async function readEntity(
  loader: (() => Promise<unknown>) | undefined,
): Promise<TelegramEntity | undefined> {
  if (!loader) {
    return undefined;
  }

  try {
    const entity = await loader();
    return entity && typeof entity === 'object'
      ? (entity as TelegramEntity)
      : undefined;
  } catch {
    return undefined;
  }
}

function readId(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === 'string' && value.trim()) {
    return value.trim();
  }
  if (typeof value === 'number' || typeof value === 'bigint') {
    return String(value);
  }
  if (typeof value === 'object' && 'toString' in value) {
    const asString = String(value);
    return asString && asString !== '[object Object]' ? asString : null;
  }
  return null;
}

function readPhone(sender: TelegramEntity | undefined): string | null {
  const phone = sender?.phone?.trim();
  if (!phone) {
    return null;
  }
  return /^\d+$/.test(phone) ? `+${phone}` : phone;
}

function formatDisplayName(sender: TelegramEntity | undefined): string | null {
  if (!sender) {
    return null;
  }

  const name = [sender.firstName, sender.lastName]
    .map((part) => part?.trim())
    .filter(Boolean)
    .join(' ');

  return name || sender.title?.trim() || sender.username?.trim() || null;
}

function toIsoDate(value: unknown): string {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return new Date(value * 1000).toISOString();
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  return new Date().toISOString();
}

function resolveMessageType(
  message: TelegramMessageWithHelpers,
): TelegramMessagePayload['type'] {
  if (message.photo) return 'image';
  if (message.voice) return 'voice';
  if (message.audio) return 'audio';
  if (message.video) return 'video';
  if (message.gif) return 'gif';
  if (message.sticker) return 'sticker';
  if (message.document) return 'file';
  if (message.media) return 'other';
  return 'text';
}
