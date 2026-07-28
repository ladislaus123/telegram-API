import assert from 'node:assert/strict';
import http from 'node:http';
import { AddressInfo } from 'node:net';
import test from 'node:test';
import pino from 'pino';
import { createApp } from '../app';

function createTestServer() {
  const sessionManager = {
    listSessions: () => [],
    getSessionStatus: (name: string) => ({
      name,
      apiId: 123456,
      hasStringSession: true,
      status: 'connected',
      lastError: null,
      createdAt: '2026-07-27T18:00:00.000Z',
      updatedAt: '2026-07-27T18:00:00.000Z',
    }),
    createSession: async (input: any) => ({
      name: input.name,
      apiId: input.apiId,
      hasStringSession: Boolean(input.stringSession),
      status: input.start ? 'connected' : 'disconnected',
      lastError: null,
      createdAt: '2026-07-27T18:00:00.000Z',
      updatedAt: '2026-07-27T18:00:00.000Z',
    }),
    updateSession: async (name: string, input: any) => ({
      name,
      apiId: input.apiId ?? 123456,
      hasStringSession: Boolean(input.stringSession ?? 'existing'),
      status: 'disconnected',
      lastError: null,
      createdAt: '2026-07-27T18:00:00.000Z',
      updatedAt: '2026-07-27T18:00:00.000Z',
    }),
    requestLoginCode: async (name: string, _phoneNumber: string) => ({
      login: {
        status: 'code_sent',
        session: name,
        isCodeViaApp: true,
        expiresAt: '2026-07-27T18:10:00.000Z',
      },
      session: {
        name,
        apiId: 123456,
        hasStringSession: false,
        status: 'auth_required',
        lastError: 'Telegram login code sent.',
        createdAt: '2026-07-27T18:00:00.000Z',
        updatedAt: '2026-07-27T18:00:00.000Z',
      },
    }),
    confirmLogin: async (name: string) => ({
      login: {
        status: 'connected',
        session: name,
      },
      session: {
        name,
        apiId: 123456,
        hasStringSession: true,
        status: 'connected',
        lastError: null,
        createdAt: '2026-07-27T18:00:00.000Z',
        updatedAt: '2026-07-27T18:00:00.000Z',
      },
    }),
    deleteSession: async () => undefined,
    sendText: async (_session: string, _to: unknown, text: string) => ({
      message: {
        providerMessageId: '1',
        session: 'main',
        chatId: '123',
        status: 'sent',
      },
      raw: { text },
    }),
    sendMedia: async (
      _session: string,
      _to: unknown,
      mediaUrl: string,
      input: unknown,
    ) => ({
      message: {
        providerMessageId: '2',
        session: 'main',
        chatId: '123',
        status: 'sent',
      },
      raw: { mediaUrl, input },
    }),
  };

  const app = createApp({
    config: {
      apiKey: 'test-key',
      defaultWebhookSecret: 'secret',
    } as any,
    logger: pino({ enabled: false }),
    store: {
      listWebhooks: () => [],
    } as any,
    mediaStore: {} as any,
    webhookDispatcher: {} as any,
    sessionManager,
  } as any);

  const server = http.createServer(app);
  return new Promise<{ baseUrl: string; close: () => Promise<void> }>((resolve) => {
    server.listen(0, () => {
      const address = server.address();
      assert.equal(typeof address, 'object');
      assert(address);
      const info = address as AddressInfo;
      resolve({
        baseUrl: `http://127.0.0.1:${info.port}`,
        close: () =>
          new Promise<void>((done) => {
            server.close(() => done());
          }),
      });
    });
  });
}

test('API routes require bearer auth', async () => {
  const server = await createTestServer();
  try {
    const response = await fetch(`${server.baseUrl}/api/sessions`);
    assert.equal(response.status, 401);
  } finally {
    await server.close();
  }
});

test('session create validates names and hides secrets', async () => {
  const server = await createTestServer();
  try {
    const invalid = await fetch(`${server.baseUrl}/api/sessions`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer test-key',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        name: 'bad name',
        apiId: 123456,
        apiHash: 'hash',
        stringSession: 'session',
      }),
    });
    assert.equal(invalid.status, 400);

    const valid = await fetch(`${server.baseUrl}/api/sessions`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer test-key',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        name: 'sales',
        apiId: 123456,
        apiHash: 'hash',
        stringSession: 'session',
        start: false,
      }),
    });

    assert.equal(valid.status, 201);
    const body = (await valid.json()) as any;
    assert.equal(body.session.name, 'sales');
    assert.equal(body.session.apiId, 123456);
    assert.equal(body.session.hasStringSession, true);
    assert.equal(body.session.apiHash, undefined);
    assert.equal(body.session.stringSession, undefined);
  } finally {
    await server.close();
  }
});

test('session create allows login flow without an existing StringSession', async () => {
  const server = await createTestServer();
  try {
    const created = await fetch(`${server.baseUrl}/api/sessions`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer test-key',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        name: 'support',
        apiId: 123456,
        apiHash: 'hash',
      }),
    });
    assert.equal(created.status, 201);
    const createdBody = (await created.json()) as any;
    assert.equal(createdBody.session.hasStringSession, false);

    const code = await fetch(`${server.baseUrl}/api/sessions/support/login/code`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer test-key',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        phoneNumber: '+15555550123',
      }),
    });
    assert.equal(code.status, 200);
    assert.equal(((await code.json()) as any).login.status, 'code_sent');

    const confirm = await fetch(
      `${server.baseUrl}/api/sessions/support/login/confirm`,
      {
        method: 'POST',
        headers: {
          authorization: 'Bearer test-key',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          code: '12345',
        }),
      },
    );
    assert.equal(confirm.status, 200);
    assert.equal(((await confirm.json()) as any).login.status, 'connected');
  } finally {
    await server.close();
  }
});

test('session update and delete routes call session manager', async () => {
  const server = await createTestServer();
  try {
    const updated = await fetch(`${server.baseUrl}/api/sessions/sales`, {
      method: 'PATCH',
      headers: {
        authorization: 'Bearer test-key',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ apiId: 654321 }),
    });
    assert.equal(updated.status, 200);
    assert.equal(((await updated.json()) as any).session.apiId, 654321);

    const deleted = await fetch(`${server.baseUrl}/api/sessions/sales`, {
      method: 'DELETE',
      headers: {
        authorization: 'Bearer test-key',
      },
    });
    assert.equal(deleted.status, 200);
  } finally {
    await server.close();
  }
});

test('text send route validates request body and calls session manager', async () => {
  const server = await createTestServer();
  try {
    const invalid = await fetch(`${server.baseUrl}/api/sessions/main/messages/text`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer test-key',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ text: 'missing recipient' }),
    });
    assert.equal(invalid.status, 400);

    const valid = await fetch(`${server.baseUrl}/api/sessions/main/messages/text`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer test-key',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        to: { type: 'chat_id', value: '123' },
        text: 'hello',
      }),
    });
    assert.equal(valid.status, 200);
    assert.equal((await valid.json() as any).message.status, 'sent');
  } finally {
    await server.close();
  }
});

test('media send route validates request body and passes media options', async () => {
  const server = await createTestServer();
  try {
    const invalid = await fetch(`${server.baseUrl}/api/sessions/main/messages/media`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer test-key',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        to: { type: 'chat_id', value: '123' },
      }),
    });
    assert.equal(invalid.status, 400);

    const valid = await fetch(`${server.baseUrl}/api/sessions/main/messages/media`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer test-key',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        to: { type: 'chat_id', value: '123' },
        mediaUrl: 'http://localhost:4020/api/media/voice-1',
        caption: 'listen',
        fileName: 'voice.ogg',
        type: 'voice',
        supportsStreaming: false,
      }),
    });
    assert.equal(valid.status, 200);
    const body = (await valid.json()) as any;
    assert.equal(body.raw.mediaUrl, 'http://localhost:4020/api/media/voice-1');
    assert.deepEqual(body.raw.input, {
      caption: 'listen',
      fileName: 'voice.ogg',
      type: 'voice',
      supportsStreaming: false,
    });
  } finally {
    await server.close();
  }
});
