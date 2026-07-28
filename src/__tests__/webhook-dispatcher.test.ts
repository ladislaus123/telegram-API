import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import pino from 'pino';
import { SqliteStore } from '../storage/sqlite-store';
import { WebhookDispatcher } from '../webhooks/webhook-dispatcher';

test('WebhookDispatcher delivers signed webhook payloads', async () => {
  let receivedSignature: string | undefined;
  let receivedBody = '';

  const receiver = http.createServer((req, res) => {
    receivedSignature = req.headers['x-telegram-connector-signature'] as string;
    req.on('data', (chunk) => {
      receivedBody += chunk;
    });
    req.on('end', () => {
      res.statusCode = 200;
      res.end('ok');
    });
  });

  const baseUrl = await new Promise<string>((resolve) => {
    receiver.listen(0, () => {
      const address = receiver.address();
      assert.equal(typeof address, 'object');
      assert(address);
      resolve(`http://127.0.0.1:${(address as AddressInfo).port}`);
    });
  });

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'telegram-connector-'));
  const store = new SqliteStore(path.join(tempDir, 'test.sqlite'));

  try {
    const webhook = store.createWebhook({
      id: 'webhook-1',
      url: `${baseUrl}/webhook`,
      events: ['session.status'],
      secret: 'secret',
      session: 'main',
    });

    const dispatcher = new WebhookDispatcher(
      store,
      {
        webhooks: {
          maxAttempts: 1,
          retryBaseMs: 0,
        },
      } as any,
      pino({ enabled: false }),
    );

    await dispatcher.dispatchTest(webhook);

    assert(receivedSignature?.startsWith('sha256='));
    assert.equal(JSON.parse(receivedBody).event, 'session.status');
  } finally {
    store.close();
    await new Promise<void>((resolve) => receiver.close(() => resolve()));
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
