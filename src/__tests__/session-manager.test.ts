import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import pino from 'pino';
import { CustomFile } from 'telegram/client/uploads';
import { HttpError } from '../http/errors';
import { SqliteStore } from '../storage/sqlite-store';
import { TelegramSessionManager } from '../telegram/session-manager';

function tempDbPath(): { dir: string; dbPath: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'telegram-connector-'));
  return { dir, dbPath: path.join(dir, 'test.sqlite') };
}

function createFakeFfmpeg(
  dir: string,
  behavior: 'success' | 'failure',
): { ffmpegPath: string; argsPath: string } {
  const ffmpegPath = path.join(dir, `fake-ffmpeg-${behavior}.js`);
  const argsPath = path.join(dir, `ffmpeg-args-${behavior}.json`);
  const script =
    behavior === 'success'
      ? `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);
fs.writeFileSync(${JSON.stringify(argsPath)}, JSON.stringify(args));
fs.writeFileSync(args[args.length - 1], 'converted-ogg');
`
      : `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);
fs.writeFileSync(${JSON.stringify(argsPath)}, JSON.stringify(args));
process.exit(1);
`;

  fs.writeFileSync(ffmpegPath, script);
  fs.chmodSync(ffmpegPath, 0o755);
  return { ffmpegPath, argsPath };
}

test('storage migrates legacy sessions and boot backfills main credentials', async () => {
  const { dir, dbPath } = tempDbPath();
  const legacyDb = new DatabaseSync(dbPath);
  legacyDb.exec(`
    CREATE TABLE sessions (
      name TEXT PRIMARY KEY,
      string_session TEXT NOT NULL,
      status TEXT NOT NULL,
      last_error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    INSERT INTO sessions
      (name, string_session, status, last_error, created_at, updated_at)
    VALUES
      ('main', 'legacy-session', 'disconnected', NULL, '2026-07-27T18:00:00.000Z', '2026-07-27T18:00:00.000Z');
  `);
  legacyDb.close();

  const store = new SqliteStore(dbPath);
  const factoryCalls: Array<{ apiId: number; apiHash: string; stringSession: string }> = [];
  const manager = new TelegramSessionManager(
    store,
    {} as any,
    { dispatch: () => undefined } as any,
    {
      telegram: {
        apiId: 777,
        apiHash: 'hash-777',
        initialStringSession: 'bootstrap-session',
        defaultSession: 'main',
        downloadInboundMedia: false,
      },
    } as any,
    pino({ enabled: false }),
    ({ apiId, apiHash, stringSession }) => {
      factoryCalls.push({ apiId, apiHash, stringSession });
      return {
        connected: true,
        connect: async () => true,
        checkAuthorization: async () => true,
        disconnect: async () => undefined,
        addEventHandler: () => undefined,
        session: {
          save: () => stringSession,
        },
      } as any;
    },
  );

  try {
    await manager.boot();
    const session = manager.getSessionStatus('main');
    assert.equal(session.apiId, 777);
    assert.equal(session.hasStringSession, true);
    assert.equal(factoryCalls[0].apiId, 777);
    assert.equal(factoryCalls[0].apiHash, 'hash-777');
    assert.equal(factoryCalls[0].stringSession, 'legacy-session');
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('session manager starts each session with its stored credentials', async () => {
  const { dir, dbPath } = tempDbPath();
  const store = new SqliteStore(dbPath);
  store.createSession({
    name: 'sales',
    apiId: 123456,
    apiHash: 'sales-hash',
    stringSession: 'sales-session',
  });
  const factoryCalls: Array<{ apiId: number; apiHash: string; stringSession: string }> = [];
  const manager = new TelegramSessionManager(
    store,
    {} as any,
    { dispatch: () => undefined } as any,
    {
      telegram: {
        apiId: null,
        apiHash: '',
        initialStringSession: '',
        defaultSession: 'main',
        downloadInboundMedia: false,
      },
    } as any,
    pino({ enabled: false }),
    ({ apiId, apiHash, stringSession }) => {
      factoryCalls.push({ apiId, apiHash, stringSession });
      return {
        connected: true,
        connect: async () => true,
        checkAuthorization: async () => true,
        disconnect: async () => undefined,
        addEventHandler: () => undefined,
        session: {
          save: () => stringSession,
        },
      } as any;
    },
  );

  try {
    await manager.startSession('sales');
    assert.deepEqual(factoryCalls[0], {
      apiId: 123456,
      apiHash: 'sales-hash',
      stringSession: 'sales-session',
    });
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('session manager completes phone code login and stores generated StringSession', async () => {
  const { dir, dbPath } = tempDbPath();
  const store = new SqliteStore(dbPath);
  store.createSession({
    name: 'support',
    apiId: 123456,
    apiHash: 'support-hash',
  });
  const calls: string[] = [];

  const manager = new TelegramSessionManager(
    store,
    {} as any,
    { dispatch: () => undefined } as any,
    {
      telegram: {
        apiId: null,
        apiHash: '',
        initialStringSession: '',
        defaultSession: 'main',
        downloadInboundMedia: false,
      },
    } as any,
    pino({ enabled: false }),
    ({ apiId, apiHash, stringSession }) => {
      calls.push(`factory:${apiId}:${apiHash}:${stringSession}`);
      return {
        connected: true,
        connect: async () => {
          calls.push('connect');
        },
        disconnect: async () => {
          calls.push('disconnect');
        },
        addEventHandler: () => undefined,
        sendCode: async (_credentials: unknown, phoneNumber: string) => {
          calls.push(`sendCode:${phoneNumber}`);
          return {
            phoneCodeHash: 'phone-code-hash',
            isCodeViaApp: true,
          };
        },
        invoke: async (request: { className?: string; phoneCode?: string }) => {
          calls.push(`${request.className}:${request.phoneCode ?? ''}`);
          return {};
        },
        session: {
          save: () => 'generated-string-session',
        },
      } as any;
    },
  );

  try {
    const codeResult = await manager.requestLoginCode('support', '+15555550123');
    assert.equal(codeResult.login.status, 'code_sent');
    assert.equal(codeResult.session.status, 'auth_required');

    const confirmResult = await manager.confirmLogin('support', { code: '12345' });
    assert.equal(confirmResult.login.status, 'connected');
    assert.equal(confirmResult.session.hasStringSession, true);
    assert.equal(store.getSession('support')?.stringSession, 'generated-string-session');
    assert.deepEqual(calls, [
      'factory:123456:support-hash:',
      'connect',
      'sendCode:+15555550123',
      'auth.SignIn:12345',
    ]);
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('session manager keeps login pending when Telegram requires 2FA password', async () => {
  const { dir, dbPath } = tempDbPath();
  const store = new SqliteStore(dbPath);
  store.createSession({
    name: 'secure',
    apiId: 123456,
    apiHash: 'secure-hash',
  });

  const manager = new TelegramSessionManager(
    store,
    {} as any,
    { dispatch: () => undefined } as any,
    {
      telegram: {
        apiId: null,
        apiHash: '',
        initialStringSession: '',
        defaultSession: 'main',
        downloadInboundMedia: false,
      },
    } as any,
    pino({ enabled: false }),
    () =>
      ({
        connected: true,
        connect: async () => undefined,
        disconnect: async () => undefined,
        addEventHandler: () => undefined,
        sendCode: async () => ({
          phoneCodeHash: 'phone-code-hash',
          isCodeViaApp: true,
        }),
        invoke: async () => {
          const error = new Error('Password required') as Error & {
            errorMessage: string;
          };
          error.errorMessage = 'SESSION_PASSWORD_NEEDED';
          throw error;
        },
        session: {
          save: () => 'generated-string-session',
        },
      }) as any,
  );

  try {
    await manager.requestLoginCode('secure', '+15555550123');
    const result = await manager.confirmLogin('secure', { code: '12345' });
    assert.equal(result.login.status, 'password_required');
    assert.equal(result.session.status, 'auth_required');
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('session manager reports invalid StringSession without leaking a 500', async () => {
  const { dir, dbPath } = tempDbPath();
  const store = new SqliteStore(dbPath);
  store.createSession({
    name: 'bad-session',
    apiId: 123456,
    apiHash: 'api-hash',
    stringSession: 'not-a-real-gramjs-session',
  });

  const manager = new TelegramSessionManager(
    store,
    {} as any,
    { dispatch: () => undefined } as any,
    {
      telegram: {
        apiId: null,
        apiHash: '',
        initialStringSession: '',
        defaultSession: 'main',
        downloadInboundMedia: false,
      },
    } as any,
    pino({ enabled: false }),
  );

  try {
    await assert.rejects(
      () => manager.startSession('bad-session', { throwOnAuthRequired: true }),
      (error) => {
        assert(error instanceof HttpError);
        assert.equal(error.statusCode, 400);
        assert.equal(error.message, 'Invalid GramJS StringSession.');
        return true;
      },
    );

    const session = manager.getSessionStatus('bad-session');
    assert.equal(session.status, 'error');
    assert.equal(session.lastError, 'Not a valid string');
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('session manager uploads connector media from local storage', async () => {
  const { dir, dbPath } = tempDbPath();
  const mediaPath = path.join(dir, 'voice.ogg');
  fs.writeFileSync(mediaPath, Buffer.from('voice'));

  const store = new SqliteStore(dbPath);
  store.createSession({
    name: 'main',
    apiId: 123456,
    apiHash: 'api-hash',
    stringSession: 'string-session',
  });
  store.createMedia({
    id: 'voice-1',
    session: 'main',
    messageId: null,
    filePath: mediaPath,
    fileName: 'voice.ogg',
    mimeType: 'audio/ogg',
    size: 5,
    createdAt: '2026-07-27T18:00:00.000Z',
  });

  let sentEntity: unknown;
  let sentParams: any;
  const manager = new TelegramSessionManager(
    store,
    { getMedia: (id: string) => store.getMedia(id) } as any,
    { dispatch: () => undefined } as any,
    {
      telegram: {
        apiId: null,
        apiHash: '',
        initialStringSession: '',
        defaultSession: 'main',
        downloadInboundMedia: false,
      },
    } as any,
    pino({ enabled: false }),
    ({ stringSession }) =>
      ({
        connected: true,
        connect: async () => undefined,
        checkAuthorization: async () => true,
        disconnect: async () => undefined,
        addEventHandler: () => undefined,
        sendFile: async (entity: unknown, params: unknown) => {
          sentEntity = entity;
          sentParams = params;
          return {
            id: 99,
            chatId: {
              toString: () => '123',
            },
          };
        },
        session: {
          save: () => stringSession,
        },
      }) as any,
  );

  try {
    await manager.startSession('main');
    const result = await manager.sendMedia(
      'main',
      { type: 'chat_id', value: '123' },
      'http://localhost:4020/api/media/voice-1',
      { caption: 'listen', type: 'voice' },
    );

    assert.equal(sentEntity, 123);
    assert(sentParams.file instanceof CustomFile);
    assert.equal(sentParams.file.name, 'voice.ogg');
    assert.equal(sentParams.file.path, mediaPath);
    assert.equal(sentParams.file.size, 5);
    assert.equal(sentParams.caption, 'listen');
    assert.equal(sentParams.voiceNote, true);
    assert.equal(sentParams.forceDocument, false);
    assert.equal(sentParams.supportsStreaming, false);
    assert.equal(result.message.providerMessageId, '99');
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('session manager converts audio media to opus ogg voice notes', async () => {
  const { dir, dbPath } = tempDbPath();
  const mediaPath = path.join(dir, 'audio.mp3');
  fs.writeFileSync(mediaPath, Buffer.from('mp3'));
  const { ffmpegPath, argsPath } = createFakeFfmpeg(dir, 'success');

  const store = new SqliteStore(dbPath);
  store.createSession({
    name: 'main',
    apiId: 123456,
    apiHash: 'api-hash',
    stringSession: 'string-session',
  });
  store.createMedia({
    id: 'audio-1',
    session: 'main',
    messageId: null,
    filePath: mediaPath,
    fileName: 'audio.mp3',
    mimeType: 'audio/mpeg',
    size: 3,
    createdAt: '2026-07-27T18:00:00.000Z',
  });

  let sentParams: any;
  const manager = new TelegramSessionManager(
    store,
    { getMedia: (id: string) => store.getMedia(id) } as any,
    { dispatch: () => undefined } as any,
    {
      telegram: {
        apiId: null,
        apiHash: '',
        initialStringSession: '',
        defaultSession: 'main',
        ffmpegPath,
        downloadInboundMedia: false,
      },
    } as any,
    pino({ enabled: false }),
    ({ stringSession }) =>
      ({
        connected: true,
        connect: async () => undefined,
        checkAuthorization: async () => true,
        disconnect: async () => undefined,
        addEventHandler: () => undefined,
        sendFile: async (_entity: unknown, params: unknown) => {
          sentParams = params;
          return {
            id: 100,
            chatId: {
              toString: () => '123',
            },
          };
        },
        session: {
          save: () => stringSession,
        },
      }) as any,
  );

  try {
    await manager.startSession('main');
    await manager.sendMedia(
      'main',
      { type: 'chat_id', value: '123' },
      'http://localhost:4020/api/media/audio-1',
      { type: 'audio' },
    );

    const ffmpegArgs = JSON.parse(fs.readFileSync(argsPath, 'utf8')) as string[];
    assert.deepEqual(ffmpegArgs.slice(0, 11), [
      '-y',
      '-i',
      mediaPath,
      '-c:a',
      'libopus',
      '-b:a',
      '32k',
      '-ac',
      '1',
      '-ar',
      '48000',
    ]);
    assert(sentParams.file instanceof CustomFile);
    assert.equal(sentParams.file.name, 'audio-voice.ogg');
    assert.equal(sentParams.file.path, ffmpegArgs[ffmpegArgs.length - 1]);
    assert.equal(sentParams.file.size, Buffer.byteLength('converted-ogg'));
    assert.equal(sentParams.voiceNote, true);
    assert.equal(sentParams.forceDocument, false);
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('session manager falls back to original audio when conversion fails', async () => {
  const { dir, dbPath } = tempDbPath();
  const mediaPath = path.join(dir, 'audio.mp3');
  fs.writeFileSync(mediaPath, Buffer.from('mp3'));
  const { ffmpegPath, argsPath } = createFakeFfmpeg(dir, 'failure');

  const store = new SqliteStore(dbPath);
  store.createSession({
    name: 'main',
    apiId: 123456,
    apiHash: 'api-hash',
    stringSession: 'string-session',
  });
  store.createMedia({
    id: 'audio-1',
    session: 'main',
    messageId: null,
    filePath: mediaPath,
    fileName: 'audio.mp3',
    mimeType: 'audio/mpeg',
    size: 3,
    createdAt: '2026-07-27T18:00:00.000Z',
  });

  let sentParams: any;
  const manager = new TelegramSessionManager(
    store,
    { getMedia: (id: string) => store.getMedia(id) } as any,
    { dispatch: () => undefined } as any,
    {
      telegram: {
        apiId: null,
        apiHash: '',
        initialStringSession: '',
        defaultSession: 'main',
        ffmpegPath,
        downloadInboundMedia: false,
      },
    } as any,
    pino({ enabled: false }),
    ({ stringSession }) =>
      ({
        connected: true,
        connect: async () => undefined,
        checkAuthorization: async () => true,
        disconnect: async () => undefined,
        addEventHandler: () => undefined,
        sendFile: async (_entity: unknown, params: unknown) => {
          sentParams = params;
          return {
            id: 101,
            chatId: {
              toString: () => '123',
            },
          };
        },
        session: {
          save: () => stringSession,
        },
      }) as any,
  );

  try {
    await manager.startSession('main');
    await manager.sendMedia(
      'main',
      { type: 'chat_id', value: '123' },
      'http://localhost:4020/api/media/audio-1',
      { type: 'audio' },
    );

    assert.equal(fs.existsSync(argsPath), true);
    assert(sentParams.file instanceof CustomFile);
    assert.equal(sentParams.file.name, 'audio.mp3');
    assert.equal(sentParams.file.path, mediaPath);
    assert.equal(sentParams.voiceNote, true);
    assert.equal(sentParams.forceDocument, false);
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('session manager does not convert non-audio media', async () => {
  const { dir, dbPath } = tempDbPath();
  const mediaPath = path.join(dir, 'photo.jpg');
  fs.writeFileSync(mediaPath, Buffer.from('jpg'));
  const { ffmpegPath, argsPath } = createFakeFfmpeg(dir, 'failure');

  const store = new SqliteStore(dbPath);
  store.createSession({
    name: 'main',
    apiId: 123456,
    apiHash: 'api-hash',
    stringSession: 'string-session',
  });
  store.createMedia({
    id: 'photo-1',
    session: 'main',
    messageId: null,
    filePath: mediaPath,
    fileName: 'photo.jpg',
    mimeType: 'image/jpeg',
    size: 3,
    createdAt: '2026-07-27T18:00:00.000Z',
  });

  let sentParams: any;
  const manager = new TelegramSessionManager(
    store,
    { getMedia: (id: string) => store.getMedia(id) } as any,
    { dispatch: () => undefined } as any,
    {
      telegram: {
        apiId: null,
        apiHash: '',
        initialStringSession: '',
        defaultSession: 'main',
        ffmpegPath,
        downloadInboundMedia: false,
      },
    } as any,
    pino({ enabled: false }),
    ({ stringSession }) =>
      ({
        connected: true,
        connect: async () => undefined,
        checkAuthorization: async () => true,
        disconnect: async () => undefined,
        addEventHandler: () => undefined,
        sendFile: async (_entity: unknown, params: unknown) => {
          sentParams = params;
          return {
            id: 102,
            chatId: {
              toString: () => '123',
            },
          };
        },
        session: {
          save: () => stringSession,
        },
      }) as any,
  );

  try {
    await manager.startSession('main');
    await manager.sendMedia(
      'main',
      { type: 'chat_id', value: '123' },
      'http://localhost:4020/api/media/photo-1',
      { type: 'image' },
    );

    assert.equal(fs.existsSync(argsPath), false);
    assert(sentParams.file instanceof CustomFile);
    assert.equal(sentParams.file.name, 'photo.jpg');
    assert.equal(sentParams.file.path, mediaPath);
    assert.equal(sentParams.voiceNote, false);
    assert.equal(sentParams.forceDocument, false);
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
