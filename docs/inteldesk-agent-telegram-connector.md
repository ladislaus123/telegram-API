# Inteldesk Agent Guide: Telegram Connector API and Webhooks

This guide is the integration contract for another Inteldesk application or
coding agent that needs to call this Telegram connector service.

The connector owns Telegram sessions through GramJS, exposes authenticated HTTP
APIs under `/api/*`, and posts signed webhooks when messages or session events
occur.

## Quick Contract

- Default local base URL: `http://localhost:4020`
- Public health endpoints: `GET /health`, `GET /ready`
- Authenticated API prefix: `/api`
- Auth header for every `/api/*` call:

```txt
Authorization: Bearer <TELEGRAM_CONNECTOR_API_KEY>
```

- JSON request bodies are strict. Extra fields are rejected with `400`.
- Session names must match `^[A-Za-z0-9_.-]+$` and be 1 to 80 chars.
- Telegram message, chat, sender, and provider IDs are strings.
- Telegram phone fields are best-effort. Telegram only exposes a user's phone
  number when the session account is allowed to see it, such as saved contacts
  or privacy-permitted users.
- A session must be `connected` before sending messages or reading chat history.
- Webhook signatures use `HMAC-SHA256(secret, timestamp + "." + rawBody)`.
- Media download URLs are protected `/api/media/:mediaId` URLs and need the same
  bearer token.

Recommended env vars in the consuming Inteldesk app:

```bash
TELEGRAM_CONNECTOR_BASE_URL=http://localhost:4020
TELEGRAM_CONNECTOR_API_KEY=replace-with-the-connector-api-key
TELEGRAM_CONNECTOR_SESSION=main
TELEGRAM_CONNECTOR_WEBHOOK_SECRET=replace-with-webhook-secret
```

## Response and Error Shape

Successful responses are JSON unless the endpoint downloads a media file.

Common error responses:

```json
{
  "error": "Invalid request",
  "details": []
}
```

```json
{
  "error": "Telegram session is not connected.",
  "details": "optional details"
}
```

Important status codes:

- `400`: invalid JSON/schema, invalid Telegram code/password, invalid
  StringSession.
- `401`: missing or invalid bearer token.
- `404`: missing session, webhook, media, or unresolvable phone recipient.
- `409`: duplicate session, auth required, no pending login, already connected,
  or session not connected.
- `502`: Telegram or upstream failure.
- `500`: unhandled server error.

## Data Models

### PublicSession

Session responses never include `apiHash` or `stringSession`.

```ts
type SessionStatus =
  | "starting"
  | "connected"
  | "disconnected"
  | "auth_required"
  | "error";

interface PublicSession {
  name: string;
  apiId: number | null;
  hasStringSession: boolean;
  status: SessionStatus;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}
```

### RecipientTarget

```ts
type RecipientTarget =
  | { type: "chat_id"; value: string }
  | { type: "username"; value: string }
  | { type: "phone"; value: string };
```

Notes:

- `username` may include or omit `@`.
- `chat_id` accepts numeric Telegram IDs as strings.
- `phone` is imported internally with Telegram contact resolution before
  sending. Responses use Telegram chat IDs when a phone is resolved. Resolution
  depends on Telegram contact and privacy rules.

### TelegramMessagePayload

Used by `message.received`, `message.edited`, and chat history.

```ts
interface TelegramMessagePayload {
  messageId: string;
  chatId: string | null;
  chatPhone: string | null;
  senderId: string | null;
  senderPhone: string | null;
  username: string | null;
  displayName: string | null;
  fromMe: boolean;
  date: string;
  type:
    | "text"
    | "image"
    | "audio"
    | "video"
    | "file"
    | "voice"
    | "sticker"
    | "gif"
    | "other";
  text: string;
  media: TelegramMessageMediaPayload | null;
  raw: unknown;
}

interface TelegramMessageMediaPayload {
  id: string;
  mimeType: string | null;
  fileName: string | null;
  size: number | null;
  downloadUrl: string;
}
```

`chatId` and `senderId` are Telegram IDs. `chatPhone` and `senderPhone` are
included when GramJS receives a visible Telegram user phone number for that peer;
otherwise they are `null`. Numeric phone values are normalized with a leading
`+`.

Live inbound webhooks can include `media` when
`TELEGRAM_DOWNLOAD_INBOUND_MEDIA=true`. Chat history currently normalizes message
type and text but does not download media, so `media` is `null` there.

## Public Endpoints

### GET /health

No auth.

Response:

```json
{ "ok": true }
```

### GET /ready

No auth.

Response:

```json
{
  "ready": true,
  "sessions": []
}
```

## Session API

### GET /api/sessions

Returns all public sessions.

```bash
curl "$TELEGRAM_CONNECTOR_BASE_URL/api/sessions" \
  -H "Authorization: Bearer $TELEGRAM_CONNECTOR_API_KEY"
```

Response:

```json
{
  "sessions": [
    {
      "name": "main",
      "apiId": 123456,
      "hasStringSession": true,
      "status": "connected",
      "lastError": null,
      "createdAt": "2026-07-27T18:00:00.000Z",
      "updatedAt": "2026-07-27T18:00:00.000Z"
    }
  ]
}
```

### POST /api/sessions

Creates a session.

Request:

```json
{
  "name": "support",
  "apiId": 123456,
  "apiHash": "telegram-api-hash",
  "stringSession": "optional-gramjs-string-session",
  "start": false
}
```

Rules:

- `apiId` and `apiHash` are required.
- `stringSession` is optional if you will use the login-code flow.
- `start=true` requires `stringSession`.

Response: `201 { "session": PublicSession }`

### GET /api/sessions/:session/status

Returns one public session.

Response: `200 { "session": PublicSession }`

### POST /api/sessions/:session/start

Starts a session that already has valid Telegram credentials and a stored
GramJS `StringSession`.

Response: `200 { "session": PublicSession }`

May return `409` when Telegram auth is still required.

### POST /api/sessions/:session/stop

Disconnects a running session.

Response: `200 { "session": PublicSession }`

### POST /api/sessions/:session/login/code

Starts phone login for a session that has `apiId` and `apiHash`.

Request:

```json
{
  "phoneNumber": "+15555550123",
  "forceSMS": false
}
```

Response:

```json
{
  "login": {
    "status": "code_sent",
    "session": "support",
    "isCodeViaApp": true,
    "expiresAt": "2026-07-27T18:10:00.000Z"
  },
  "session": {
    "name": "support",
    "apiId": 123456,
    "hasStringSession": false,
    "status": "auth_required",
    "lastError": "Telegram login code sent.",
    "createdAt": "2026-07-27T18:00:00.000Z",
    "updatedAt": "2026-07-27T18:00:00.000Z"
  }
}
```

The pending login expires after about 10 minutes.

### POST /api/sessions/:session/login/confirm

Confirm with the Telegram login code:

```json
{ "code": "12345" }
```

If Telegram requires 2FA, response is:

```json
{
  "login": {
    "status": "password_required",
    "session": "support"
  },
  "session": {
    "name": "support",
    "apiId": 123456,
    "hasStringSession": false,
    "status": "auth_required",
    "lastError": "Telegram 2FA password required.",
    "createdAt": "2026-07-27T18:00:00.000Z",
    "updatedAt": "2026-07-27T18:00:00.000Z"
  }
}
```

Confirm again with the 2FA password:

```json
{ "password": "telegram-2fa-password" }
```

Connected response:

```json
{
  "login": {
    "status": "connected",
    "session": "support"
  },
  "session": {
    "name": "support",
    "apiId": 123456,
    "hasStringSession": true,
    "status": "connected",
    "lastError": null,
    "createdAt": "2026-07-27T18:00:00.000Z",
    "updatedAt": "2026-07-27T18:00:00.000Z"
  }
}
```

### PATCH /api/sessions/:session

Updates Telegram credentials. Provide at least one field.

```json
{
  "apiId": 654321,
  "apiHash": "new-api-hash",
  "stringSession": "new-gramjs-string-session"
}
```

Response: `200 { "session": PublicSession }`

If the session was connected, the connector stops it, updates credentials, and
attempts to start it again.

### DELETE /api/sessions/:session

Deletes a session.

Response:

```json
{ "success": true }
```

## Message API

### POST /api/sessions/:session/messages/text

Sends a text message and emits a `message.sent` webhook.

Request:

```json
{
  "to": {
    "type": "chat_id",
    "value": "123456789"
  },
  "text": "Hello from Inteldesk"
}
```

Response:

```json
{
  "message": {
    "providerMessageId": "1001",
    "session": "main",
    "chatId": "123456789",
    "status": "sent"
  },
  "raw": {
    "id": "1001",
    "chatId": "123456789"
  }
}
```

### POST /api/sessions/:session/messages/media

Sends a media URL and emits a `message.sent` webhook.

Request:

```json
{
  "to": {
    "type": "username",
    "value": "@example"
  },
  "mediaUrl": "https://example.com/file.jpg",
  "caption": "Optional caption",
  "fileName": "optional-name.jpg",
  "type": "image"
}
```

Response shape is the same as text sending. `fileName` is included in the
`message.sent` webhook payload for Inteldesk metadata. The connector downloads
`mediaUrl` itself and uploads the file to Telegram, so connector-owned,
localhost, private, and signed URLs do not need to be fetched directly by
Telegram. Optional `type` values are `image`, `audio`, `video`, `file`, and
`voice`; audio-like files and `audio`/`voice` requests are converted with
`ffmpeg` to Opus OGG Telegram voice notes, falling back to the original file if
conversion fails. Set `TELEGRAM_FFMPEG_PATH` when the binary is not available as
`ffmpeg` on `PATH`. `video` enables streaming by default.

### GET /api/sessions/:session/chats/:chatId/messages

Reads recent chat history from Telegram.

Query:

- `limit`: positive integer, max `100`, default `50`.

```bash
curl "$TELEGRAM_CONNECTOR_BASE_URL/api/sessions/main/chats/123456789/messages?limit=50" \
  -H "Authorization: Bearer $TELEGRAM_CONNECTOR_API_KEY"
```

Response:

```json
{
  "messages": [
    {
      "messageId": "1001",
      "chatId": "123456789",
      "chatPhone": "+15555550123",
      "senderId": "987654321",
      "senderPhone": "+15555550123",
      "username": "customer",
      "displayName": "Customer Name",
      "fromMe": false,
      "date": "2026-07-27T18:00:00.000Z",
      "type": "text",
      "text": "Hello",
      "media": null,
      "raw": {
        "id": "1001",
        "chatId": "123456789",
        "senderId": "987654321",
        "out": false,
        "groupedId": null
      }
    }
  ]
}
```

Messages are returned oldest-to-newest within the requested recent window.

### GET /api/media/:mediaId

Downloads an inbound media file stored by the connector.

```bash
curl "$TELEGRAM_CONNECTOR_BASE_URL/api/media/$MEDIA_ID" \
  -H "Authorization: Bearer $TELEGRAM_CONNECTOR_API_KEY" \
  -o telegram-media.bin
```

Response is binary. The connector sets `Content-Type` when it knows the MIME
type and `Content-Disposition` when it knows the original filename.

## Webhook Management API

### GET /api/webhooks

Returns active webhook subscriptions. The response includes the webhook `secret`,
so treat it as sensitive.

```json
{
  "webhooks": [
    {
      "id": "uuid",
      "url": "https://inteldesk.example.com/api/providers/telegram/webhook",
      "events": ["message.received"],
      "secret": "webhook-secret",
      "session": "main",
      "active": true,
      "createdAt": "2026-07-27T18:00:00.000Z",
      "updatedAt": "2026-07-27T18:00:00.000Z"
    }
  ]
}
```

### POST /api/webhooks

Creates a webhook subscription.

Request:

```json
{
  "url": "https://inteldesk.example.com/api/providers/telegram/webhook",
  "events": [
    "message.received",
    "message.edited",
    "message.deleted",
    "message.sent",
    "session.status",
    "session.error"
  ],
  "secret": "replace-with-webhook-secret",
  "session": "main"
}
```

Rules:

- `events` must contain at least one supported event.
- `secret` is optional. If omitted, the connector uses `WEBHOOK_SIGNING_SECRET`.
- `session` is optional or `null`. Omit it to receive events for all sessions.

Supported events:

```txt
message.received
message.edited
message.deleted
message.sent
session.status
session.error
```

Response: `201 { "webhook": WebhookSubscription }`

### DELETE /api/webhooks/:id

Deactivates a webhook subscription.

Response:

```json
{ "success": true }
```

### POST /api/webhooks/:id/test

Sends a signed test webhook to the subscription URL.

Response:

```json
{ "success": true }
```

The test event is `session.status` with payload:

```json
{ "status": "test" }
```

## Incoming Webhook Delivery Contract

The connector sends `POST` requests to each webhook URL.

Headers:

```txt
content-type: application/json
x-telegram-connector-event: message.received
x-telegram-connector-delivery: uuid
x-telegram-connector-timestamp: 2026-07-27T18:00:00.000Z
x-telegram-connector-signature: sha256=<hex-hmac>
```

Body envelope:

```json
{
  "provider": "telegram",
  "event": "message.received",
  "session": "main",
  "timestamp": "2026-07-27T18:00:00.000Z",
  "payload": {}
}
```

Delivery behavior:

- Any `2xx` response marks the delivery as successful.
- Any non-`2xx` response or network error is retried.
- Retry count is controlled by `WEBHOOK_MAX_ATTEMPTS`, default `3`.
- Retry delay is exponential using `WEBHOOK_RETRY_BASE_MS`, default `1000`.
- The delivery ID stays the same across retries for the same webhook delivery.
- The body `timestamp` and timestamp header are regenerated per attempt.

The receiving app should:

- Verify the signature against the exact raw request body before trusting data.
- Store or dedupe `x-telegram-connector-delivery` to make retries idempotent.
- Return `2xx` only after the event is durably accepted or queued.
- Keep processing fast. Do slow CRM/ticket/AI work asynchronously.

## Webhook Signature Verification

Signature formula:

```txt
sha256=<HMAC_SHA256_HEX(secret, timestamp + "." + rawBody)>
```

Express example:

```ts
import crypto from "node:crypto";
import express from "express";

const app = express();

app.use(
  express.json({
    verify: (req, _res, buf) => {
      (req as express.Request & { rawBody?: string }).rawBody = buf.toString("utf8");
    },
  }),
);

function verifyTelegramConnectorSignature(params: {
  secret: string;
  timestamp: string | undefined;
  rawBody: string | undefined;
  signature: string | undefined;
}): boolean {
  const { secret, timestamp, rawBody, signature } = params;
  if (!timestamp || !rawBody || !signature?.startsWith("sha256=")) {
    return false;
  }

  const expected =
    "sha256=" +
    crypto
      .createHmac("sha256", secret)
      .update(`${timestamp}.${rawBody}`)
      .digest("hex");

  const expectedBuffer = Buffer.from(expected, "utf8");
  const signatureBuffer = Buffer.from(signature, "utf8");

  return (
    expectedBuffer.length === signatureBuffer.length &&
    crypto.timingSafeEqual(expectedBuffer, signatureBuffer)
  );
}

app.post("/api/providers/telegram/webhook", async (req, res) => {
  const secret = process.env.TELEGRAM_CONNECTOR_WEBHOOK_SECRET!;
  const rawBody = (req as express.Request & { rawBody?: string }).rawBody;

  const ok = verifyTelegramConnectorSignature({
    secret,
    timestamp: req.header("x-telegram-connector-timestamp"),
    rawBody,
    signature: req.header("x-telegram-connector-signature"),
  });

  if (!ok) {
    return res.status(401).json({ error: "Invalid Telegram connector signature" });
  }

  const deliveryId = req.header("x-telegram-connector-delivery");
  const event = req.body as TelegramConnectorWebhook;

  // Recommended: insert deliveryId into an idempotency table before processing.
  // If it already exists, return 200 so connector retries stop.

  await queueTelegramConnectorEvent({ deliveryId, event });
  return res.status(200).json({ ok: true });
});
```

Optional replay protection: reject timestamps older than a small window, such as
5 minutes, after accounting for clock skew. Keep in mind retries regenerate the
timestamp, so replay checks should use the delivery ID for idempotency.

## Webhook Payloads by Event

### message.received

Payload: `TelegramMessagePayload`

Example:

```json
{
  "provider": "telegram",
  "event": "message.received",
  "session": "main",
  "timestamp": "2026-07-27T18:00:00.000Z",
  "payload": {
      "messageId": "1001",
      "chatId": "123456789",
      "chatPhone": "+15555550123",
      "senderId": "987654321",
      "senderPhone": "+15555550123",
      "username": "customer",
      "displayName": "Customer Name",
    "fromMe": false,
    "date": "2026-07-27T18:00:00.000Z",
    "type": "image",
    "text": "See attached",
    "media": {
      "id": "media-id",
      "mimeType": "image/jpeg",
      "fileName": "telegram-1001.jpg",
      "size": 123456,
      "downloadUrl": "https://telegram-connector.example.com/api/media/media-id"
    },
    "raw": {
      "id": "1001",
      "chatId": "123456789",
      "senderId": "987654321",
      "out": false,
      "groupedId": null
    }
  }
}
```

### message.edited

Payload: `TelegramMessagePayload`

Same shape as `message.received`. Media is not downloaded for edited events.

### message.deleted

Payload:

```json
{
  "messageIds": ["1001", "1002"],
  "peer": "optional-peer-or-null"
}
```

### message.sent

Text-send payload:

```json
{
  "providerMessageId": "1001",
  "session": "main",
  "chatId": "123456789",
  "status": "sent"
}
```

Media-send payload:

```json
{
  "providerMessageId": "1001",
  "session": "main",
  "chatId": "123456789",
  "status": "sent",
  "mediaUrl": "https://example.com/file.jpg",
  "fileName": "optional-name.jpg",
  "type": "image"
}
```

### session.status

Payload:

```json
{
  "status": "connected",
  "error": null
}
```

Non-error statuses are `starting`, `connected`, `disconnected`, and
`auth_required`. Test webhooks send `{ "status": "test" }`.

### session.error

Payload:

```json
{
  "status": "error",
  "error": "Telegram or connector error message"
}
```

## Suggested TypeScript Client for Inteldesk

```ts
type Json = Record<string, unknown>;

export class TelegramConnectorClient {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly defaultSession = "main",
  ) {}

  async listSessions() {
    return this.get("/api/sessions");
  }

  async sendText(params: {
    session?: string;
    to: RecipientTarget;
    text: string;
  }) {
    const session = encodeURIComponent(params.session ?? this.defaultSession);
    return this.post(`/api/sessions/${session}/messages/text`, {
      to: params.to,
      text: params.text,
    });
  }

  async sendMedia(params: {
    session?: string;
    to: RecipientTarget;
    mediaUrl: string;
    caption?: string;
    fileName?: string;
    type?: "image" | "audio" | "video" | "file" | "voice";
    forceDocument?: boolean;
    supportsStreaming?: boolean;
  }) {
    const session = encodeURIComponent(params.session ?? this.defaultSession);
    return this.post(`/api/sessions/${session}/messages/media`, {
      to: params.to,
      mediaUrl: params.mediaUrl,
      caption: params.caption,
      fileName: params.fileName,
      type: params.type,
      forceDocument: params.forceDocument,
      supportsStreaming: params.supportsStreaming,
    });
  }

  async listMessages(params: {
    session?: string;
    chatId: string;
    limit?: number;
  }) {
    const session = encodeURIComponent(params.session ?? this.defaultSession);
    const chatId = encodeURIComponent(params.chatId);
    const limit = params.limit ?? 50;
    return this.get(
      `/api/sessions/${session}/chats/${chatId}/messages?limit=${limit}`,
    );
  }

  async createWebhook(params: {
    url: string;
    events: string[];
    secret: string;
    session?: string | null;
  }) {
    return this.post("/api/webhooks", params);
  }

  private async get(path: string) {
    return this.request(path, { method: "GET" });
  }

  private async post(path: string, body: Json) {
    return this.request(path, {
      method: "POST",
      body: JSON.stringify(body),
    });
  }

  private async request(path: string, init: RequestInit) {
    const response = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        "content-type": "application/json",
        ...init.headers,
      },
    });

    const contentType = response.headers.get("content-type") ?? "";
    const payload = contentType.includes("application/json")
      ? await response.json()
      : await response.text();

    if (!response.ok) {
      throw new Error(
        `Telegram connector ${response.status}: ${JSON.stringify(payload)}`,
      );
    }

    return payload;
  }
}
```

When downloading media, call `payload.media.downloadUrl` with the bearer token
and stream the binary response to durable storage.

## Recommended Inteldesk Workflows

### First-time setup

1. Configure the connector `.env`.
2. Start the connector.
3. Create a session with `POST /api/sessions`.
4. Complete Telegram login with `/login/code` and `/login/confirm`.
5. Confirm status is `connected`.
6. Create a webhook pointed at the Inteldesk receiving route.
7. Call `POST /api/webhooks/:id/test` and verify signature handling.

### Inbound message handling

1. Receive webhook.
2. Verify signature using the raw body.
3. Deduplicate by `x-telegram-connector-delivery`.
4. Map `payload.chatId` to an Inteldesk contact/conversation.
5. Store `payload.messageId` as the Telegram provider message ID.
6. If `payload.media` exists, download it from `downloadUrl` with bearer auth.
7. Queue downstream AI/ticketing workflows.
8. Return `2xx`.

### Sending replies

1. Confirm the desired session is connected, or handle a `409`.
2. Use `chat_id` with the known Telegram chat ID when replying to an inbound
   conversation.
3. Call `messages/text` or `messages/media`.
4. Store `message.providerMessageId` returned by the send API.
5. Treat the later `message.sent` webhook as confirmation/idempotent metadata.

### Backfilling conversation history

1. Call `GET /api/sessions/:session/chats/:chatId/messages?limit=100`.
2. Upsert by `(session, chatId, messageId)`.
3. Do not expect media files from history; use live inbound webhooks for media
   capture.

## Minimal cURL Smoke Test

```bash
curl "$TELEGRAM_CONNECTOR_BASE_URL/health"

curl "$TELEGRAM_CONNECTOR_BASE_URL/api/sessions" \
  -H "Authorization: Bearer $TELEGRAM_CONNECTOR_API_KEY"

curl -X POST "$TELEGRAM_CONNECTOR_BASE_URL/api/sessions/$TELEGRAM_CONNECTOR_SESSION/messages/text" \
  -H "Authorization: Bearer $TELEGRAM_CONNECTOR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "to": { "type": "chat_id", "value": "123456789" },
    "text": "Smoke test from Inteldesk"
  }'
```
