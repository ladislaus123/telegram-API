#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const http = require('node:http');

const port = readPort(process.env.WEBHOOK_LISTENER_PORT ?? process.env.PORT, 5050);
const host = process.env.WEBHOOK_LISTENER_HOST || '127.0.0.1';
const webhookPath = process.env.WEBHOOK_LISTENER_PATH || '/webhook';
const secret =
  process.env.TELEGRAM_CONNECTOR_WEBHOOK_SECRET ||
  process.env.WEBHOOK_SIGNING_SECRET ||
  process.env.WEBHOOK_SECRET ||
  'dev-webhook-secret';
const verifySignatures = process.env.WEBHOOK_VERIFY_SIGNATURE !== 'false';

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', `http://${req.headers.host || `${host}:${port}`}`);

    if (req.method === 'GET' && url.pathname === '/health') {
      return sendJson(res, 200, { ok: true });
    }

    if (req.method !== 'POST' || url.pathname !== webhookPath) {
      return sendJson(res, 404, {
        error: 'Not found',
        expected: `POST ${webhookPath}`,
      });
    }

    const rawBody = await readRawBody(req);
    const timestamp = readHeader(req, 'x-telegram-connector-timestamp');
    const signature = readHeader(req, 'x-telegram-connector-signature');

    if (verifySignatures) {
      const verification = verifyWebhookSignature({
        secret,
        timestamp,
        rawBody,
        signature,
      });

      if (!verification.ok) {
        console.warn(`[webhook] rejected delivery: ${verification.reason}`);
        return sendJson(res, 401, {
          error: 'Invalid webhook signature',
          reason: verification.reason,
        });
      }
    }

    let body;
    try {
      body = rawBody.length > 0 ? JSON.parse(rawBody) : null;
    } catch (error) {
      console.warn(`[webhook] invalid JSON: ${error.message}`);
      return sendJson(res, 400, { error: 'Invalid JSON body' });
    }

    const event = readHeader(req, 'x-telegram-connector-event') || body?.event || 'unknown';
    const deliveryId = readHeader(req, 'x-telegram-connector-delivery') || 'missing-delivery-id';

    console.log('');
    console.log(`[webhook] ${new Date().toISOString()} ${event}`);
    console.log(`delivery: ${deliveryId}`);
    console.log(`session:  ${body?.session ?? 'unknown'}`);
    console.log(`signed:   ${verifySignatures ? 'verified' : 'disabled'}`);
    console.log('headers:');
    console.log(
      JSON.stringify(
        {
          event: readHeader(req, 'x-telegram-connector-event'),
          delivery: deliveryId,
          timestamp,
          signature,
        },
        null,
        2,
      ),
    );
    console.log('body:');
    console.log(JSON.stringify(body, null, 2));

    return sendJson(res, 202, {
      ok: true,
      accepted: true,
      event,
      deliveryId,
    });
  } catch (error) {
    console.error('[webhook] unhandled listener error:', error);
    return sendJson(res, 500, { error: 'Webhook listener error' });
  }
});

server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    console.error(`[webhook] ${host}:${port} is already in use.`);
  } else if (error.code === 'EACCES' || error.code === 'EPERM') {
    console.error(`[webhook] permission denied while binding ${host}:${port}.`);
  } else {
    console.error('[webhook] failed to start listener:', error);
  }
  process.exit(1);
});

server.listen(port, host, () => {
  const localUrl = `http://${host}:${port}${webhookPath}`;

  console.log('Telegram connector webhook test listener');
  console.log(`listening: ${localUrl}`);
  console.log(`health:    http://${host}:${port}/health`);
  console.log(`secret:    ${secret}`);
  console.log(`verify:    ${verifySignatures ? 'on' : 'off'}`);
  console.log('');
  console.log('Register it with the connector:');
  console.log(`curl -X POST http://localhost:4020/api/webhooks \\`);
  console.log(`  -H "Authorization: Bearer $TELEGRAM_CONNECTOR_API_KEY" \\`);
  console.log(`  -H "Content-Type: application/json" \\`);
  console.log(
    `  -d '{"url":"${localUrl}","events":["message.received","message.edited","message.deleted","message.sent","session.status","session.error"],"secret":"${secret}","session":"main"}'`,
  );
});

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

function shutdown() {
  console.log('\n[webhook] shutting down');
  if (!server.listening) {
    process.exit(0);
  }
  server.close(() => process.exit(0));
}

function verifyWebhookSignature({ secret, timestamp, rawBody, signature }) {
  if (!timestamp) {
    return { ok: false, reason: 'Missing x-telegram-connector-timestamp header' };
  }

  if (!signature) {
    return { ok: false, reason: 'Missing x-telegram-connector-signature header' };
  }

  const expected = createWebhookSignature(secret, timestamp, rawBody);
  const expectedBuffer = Buffer.from(expected);
  const signatureBuffer = Buffer.from(signature);

  if (
    expectedBuffer.length !== signatureBuffer.length ||
    !crypto.timingSafeEqual(expectedBuffer, signatureBuffer)
  ) {
    return { ok: false, reason: 'Signature mismatch' };
  }

  return { ok: true };
}

function createWebhookSignature(signingSecret, timestamp, rawBody) {
  const digest = crypto
    .createHmac('sha256', signingSecret)
    .update(`${timestamp}.${rawBody}`)
    .digest('hex');
  return `sha256=${digest}`;
}

function readHeader(req, name) {
  const value = req.headers[name];
  if (Array.isArray(value)) {
    return value[0];
  }
  return value;
}

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    'content-type': 'application/json',
  });
  res.end(`${JSON.stringify(payload)}\n`);
}

function readPort(value, fallback) {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}
