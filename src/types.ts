export type SessionStatus =
  | 'starting'
  | 'connected'
  | 'disconnected'
  | 'auth_required'
  | 'error';

export type WebhookEvent =
  | 'message.received'
  | 'message.edited'
  | 'message.deleted'
  | 'message.sent'
  | 'session.status'
  | 'session.error';

export type RecipientTargetType = 'chat_id' | 'username' | 'phone';

export interface RecipientTarget {
  type: RecipientTargetType;
  value: string;
}

export interface ConnectorSessionRecord {
  name: string;
  apiId: number;
  apiHash: string;
  stringSession: string;
  status: SessionStatus;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PublicSessionRecord {
  name: string;
  apiId: number | null;
  hasStringSession: boolean;
  status: SessionStatus;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface WebhookSubscription {
  id: string;
  url: string;
  events: WebhookEvent[];
  secret: string;
  session: string | null;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface MediaRecord {
  id: string;
  session: string;
  messageId: string | null;
  filePath: string;
  fileName: string | null;
  mimeType: string | null;
  size: number | null;
  createdAt: string;
}

export interface TelegramMessageMediaPayload {
  id: string;
  mimeType: string | null;
  fileName: string | null;
  size: number | null;
  downloadUrl: string;
}

export interface TelegramMessagePayload {
  messageId: string;
  chatId: string | null;
  chatPhone: string | null;
  senderId: string | null;
  senderPhone: string | null;
  username: string | null;
  displayName: string | null;
  fromMe: boolean;
  date: string;
  type: 'text' | 'image' | 'audio' | 'video' | 'file' | 'voice' | 'sticker' | 'gif' | 'other';
  text: string;
  media: TelegramMessageMediaPayload | null;
  raw: unknown;
}

export interface TelegramConnectorEvent<TPayload = unknown> {
  provider: 'telegram';
  event: WebhookEvent;
  session: string;
  timestamp: string;
  payload: TPayload;
}

export interface SendMessageResult {
  message: {
    providerMessageId: string;
    session: string;
    chatId: string;
    status: 'sent';
  };
  raw: unknown;
}
