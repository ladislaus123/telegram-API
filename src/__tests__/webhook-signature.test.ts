import assert from 'node:assert/strict';
import test from 'node:test';
import crypto from 'node:crypto';
import { createWebhookSignature } from '../webhooks/webhook-signature';

test('createWebhookSignature signs timestamp and raw body with HMAC-SHA256', () => {
  const secret = 'test-secret';
  const timestamp = '2026-07-27T18:00:00.000Z';
  const rawBody = '{"provider":"telegram"}';

  const expected = `sha256=${crypto
    .createHmac('sha256', secret)
    .update(`${timestamp}.${rawBody}`)
    .digest('hex')}`;

  assert.equal(createWebhookSignature(secret, timestamp, rawBody), expected);
});
