import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  ConnectorSessionRecord,
  MediaRecord,
  SessionStatus,
  WebhookEvent,
  WebhookSubscription,
} from '../types';

interface SessionRow {
  name: string;
  api_id: number;
  api_hash: string;
  string_session: string;
  status: SessionStatus;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

interface WebhookRow {
  id: string;
  url: string;
  events: string;
  secret: string;
  session: string | null;
  active: number;
  created_at: string;
  updated_at: string;
}

interface MediaRow {
  id: string;
  session: string;
  message_id: string | null;
  file_path: string;
  file_name: string | null;
  mime_type: string | null;
  size: number | null;
  created_at: string;
}

export interface CreateWebhookInput {
  id: string;
  url: string;
  events: WebhookEvent[];
  secret: string;
  session?: string | null;
}

export interface CreateDeliveryInput {
  id: string;
  webhookId: string;
  event: WebhookEvent;
  session: string;
}

export interface UpdateDeliveryInput {
  attempts: number;
  status: 'pending' | 'delivered' | 'failed';
  statusCode?: number | null;
  error?: string | null;
  nextAttemptAt?: string | null;
}

export interface CreateSessionInput {
  name: string;
  apiId: number;
  apiHash: string;
  stringSession?: string;
}

export interface UpdateSessionInput {
  apiId?: number;
  apiHash?: string;
  stringSession?: string;
}

export class SqliteStore {
  private readonly db: DatabaseSync;

  constructor(readonly databasePath: string) {
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });
    this.db = new DatabaseSync(databasePath);
    this.migrate();
  }

  close(): void {
    this.db.close();
  }

  private migrate(): void {
    this.db.exec(`
      PRAGMA journal_mode = WAL;

      CREATE TABLE IF NOT EXISTS sessions (
        name TEXT PRIMARY KEY,
        api_id INTEGER NOT NULL DEFAULT 0,
        api_hash TEXT NOT NULL DEFAULT '',
        string_session TEXT NOT NULL,
        status TEXT NOT NULL,
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS webhooks (
        id TEXT PRIMARY KEY,
        url TEXT NOT NULL,
        events TEXT NOT NULL,
        secret TEXT NOT NULL,
        session TEXT,
        active INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS webhook_deliveries (
        id TEXT PRIMARY KEY,
        webhook_id TEXT NOT NULL,
        event TEXT NOT NULL,
        session TEXT NOT NULL,
        status TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        last_status_code INTEGER,
        last_error TEXT,
        next_attempt_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (webhook_id) REFERENCES webhooks(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS media_files (
        id TEXT PRIMARY KEY,
        session TEXT NOT NULL,
        message_id TEXT,
        file_path TEXT NOT NULL,
        file_name TEXT,
        mime_type TEXT,
        size INTEGER,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS processed_messages (
        key TEXT PRIMARY KEY,
        created_at TEXT NOT NULL
      );
    `);
    this.ensureSessionCredentialColumns();
  }

  private ensureSessionCredentialColumns(): void {
    const columns = new Set(
      this.db
        .prepare('PRAGMA table_info(sessions)')
        .all()
        .map((row) => String((row as { name: string }).name)),
    );

    if (!columns.has('api_id')) {
      this.db.exec("ALTER TABLE sessions ADD COLUMN api_id INTEGER NOT NULL DEFAULT 0");
    }

    if (!columns.has('api_hash')) {
      this.db.exec("ALTER TABLE sessions ADD COLUMN api_hash TEXT NOT NULL DEFAULT ''");
    }
  }

  ensureSession(input: CreateSessionInput): ConnectorSessionRecord {
    const existing = this.getSession(input.name);
    if (existing) {
      const updates: UpdateSessionInput = {};
      if (input.apiId > 0 && existing.apiId <= 0) {
        updates.apiId = input.apiId;
      }
      if (input.apiHash && !existing.apiHash) {
        updates.apiHash = input.apiHash;
      }
      if (input.stringSession && !existing.stringSession) {
        updates.stringSession = input.stringSession;
      }
      if (Object.keys(updates).length > 0) {
        this.updateSession(input.name, updates);
        return this.getRequiredSession(input.name);
      }
      return existing;
    }

    return this.createSession(input);
  }

  createSession(input: CreateSessionInput): ConnectorSessionRecord {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO sessions
         (name, api_id, api_hash, string_session, status, last_error, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, NULL, ?, ?)`,
      )
      .run(
        input.name,
        input.apiId,
        input.apiHash,
        input.stringSession ?? '',
        'disconnected',
        now,
        now,
      );

    return this.getRequiredSession(input.name);
  }

  listSessions(): ConnectorSessionRecord[] {
    return this.db
      .prepare('SELECT * FROM sessions ORDER BY name ASC')
      .all()
      .map((row) => this.toSessionRecord(row as unknown as SessionRow));
  }

  getSession(name: string): ConnectorSessionRecord | null {
    const row = this.db
      .prepare('SELECT * FROM sessions WHERE name = ?')
      .get(name) as unknown as SessionRow | undefined;

    return row ? this.toSessionRecord(row) : null;
  }

  updateSessionStatus(
    name: string,
    status: SessionStatus,
    lastError: string | null = null,
  ): void {
    this.db
      .prepare(
        `UPDATE sessions
         SET status = ?, last_error = ?, updated_at = ?
         WHERE name = ?`,
      )
      .run(status, lastError, new Date().toISOString(), name);
  }

  updateSessionStringSession(name: string, stringSession: string): void {
    this.updateSession(name, { stringSession });
  }

  updateSession(name: string, input: UpdateSessionInput): ConnectorSessionRecord {
    const existing = this.getSession(name);
    if (!existing) {
      throw new Error(`Session "${name}" does not exist.`);
    }

    const next = {
      apiId: input.apiId ?? existing.apiId,
      apiHash: input.apiHash ?? existing.apiHash,
      stringSession: input.stringSession ?? existing.stringSession,
    };

    this.db
      .prepare(
        `UPDATE sessions
         SET api_id = ?, api_hash = ?, string_session = ?, updated_at = ?
         WHERE name = ?`,
      )
      .run(
        next.apiId,
        next.apiHash,
        next.stringSession,
        new Date().toISOString(),
        name,
      );

    return this.getRequiredSession(name);
  }

  deleteSession(name: string): boolean {
    const result = this.db.prepare('DELETE FROM sessions WHERE name = ?').run(name);
    return result.changes > 0;
  }

  createWebhook(input: CreateWebhookInput): WebhookSubscription {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO webhooks (id, url, events, secret, session, active, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 1, ?, ?)`,
      )
      .run(
        input.id,
        input.url,
        JSON.stringify(input.events),
        input.secret,
        input.session ?? null,
        now,
        now,
      );

    return this.getRequiredWebhook(input.id);
  }

  listWebhooks(): WebhookSubscription[] {
    return this.db
      .prepare('SELECT * FROM webhooks WHERE active = 1 ORDER BY created_at DESC')
      .all()
      .map((row) => this.toWebhook(row as unknown as WebhookRow));
  }

  listMatchingWebhooks(
    event: WebhookEvent,
    session: string,
  ): WebhookSubscription[] {
    return this.listWebhooks().filter(
      (webhook) =>
        webhook.events.includes(event) &&
        (!webhook.session || webhook.session === session),
    );
  }

  getWebhook(id: string): WebhookSubscription | null {
    const row = this.db
      .prepare('SELECT * FROM webhooks WHERE id = ? AND active = 1')
      .get(id) as unknown as WebhookRow | undefined;
    return row ? this.toWebhook(row) : null;
  }

  deleteWebhook(id: string): boolean {
    const result = this.db
      .prepare('UPDATE webhooks SET active = 0, updated_at = ? WHERE id = ? AND active = 1')
      .run(new Date().toISOString(), id);
    return result.changes > 0;
  }

  createDelivery(input: CreateDeliveryInput): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO webhook_deliveries
         (id, webhook_id, event, session, status, attempts, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'pending', 0, ?, ?)`,
      )
      .run(input.id, input.webhookId, input.event, input.session, now, now);
  }

  updateDelivery(id: string, input: UpdateDeliveryInput): void {
    this.db
      .prepare(
        `UPDATE webhook_deliveries
         SET attempts = ?,
             status = ?,
             last_status_code = ?,
             last_error = ?,
             next_attempt_at = ?,
             updated_at = ?
         WHERE id = ?`,
      )
      .run(
        input.attempts,
        input.status,
        input.statusCode ?? null,
        input.error ?? null,
        input.nextAttemptAt ?? null,
        new Date().toISOString(),
        id,
      );
  }

  hasProcessedMessage(key: string): boolean {
    const row = this.db
      .prepare('SELECT key FROM processed_messages WHERE key = ?')
      .get(key);
    return Boolean(row);
  }

  markProcessedMessage(key: string): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO processed_messages (key, created_at)
         VALUES (?, ?)`,
      )
      .run(key, new Date().toISOString());
  }

  createMedia(record: MediaRecord): MediaRecord {
    this.db
      .prepare(
        `INSERT INTO media_files
         (id, session, message_id, file_path, file_name, mime_type, size, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.session,
        record.messageId,
        record.filePath,
        record.fileName,
        record.mimeType,
        record.size,
        record.createdAt,
      );
    return record;
  }

  getMedia(id: string): MediaRecord | null {
    const row = this.db
      .prepare('SELECT * FROM media_files WHERE id = ?')
      .get(id) as unknown as MediaRow | undefined;
    return row ? this.toMedia(row) : null;
  }

  private getRequiredSession(name: string): ConnectorSessionRecord {
    const session = this.getSession(name);
    if (!session) {
      throw new Error(`Session "${name}" was not found after write.`);
    }
    return session;
  }

  private getRequiredWebhook(id: string): WebhookSubscription {
    const webhook = this.getWebhook(id);
    if (!webhook) {
      throw new Error(`Webhook "${id}" was not found after write.`);
    }
    return webhook;
  }

  private toSessionRecord(row: SessionRow): ConnectorSessionRecord {
    return {
      name: row.name,
      apiId: row.api_id,
      apiHash: row.api_hash,
      stringSession: row.string_session,
      status: row.status,
      lastError: row.last_error,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private toWebhook(row: WebhookRow): WebhookSubscription {
    return {
      id: row.id,
      url: row.url,
      events: JSON.parse(row.events) as WebhookEvent[],
      secret: row.secret,
      session: row.session,
      active: row.active === 1,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private toMedia(row: MediaRow): MediaRecord {
    return {
      id: row.id,
      session: row.session,
      messageId: row.message_id,
      filePath: row.file_path,
      fileName: row.file_name,
      mimeType: row.mime_type,
      size: row.size,
      createdAt: row.created_at,
    };
  }
}
