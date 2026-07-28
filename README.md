# Telegram Connector Service

Independent Telegram connector service backed by GramJS. It owns Telegram
session lifecycle, accepts authenticated HTTP requests to send messages, and
emits signed webhooks for received messages and session events.

## Setup

```bash
npm install
cp .env.example .env
npm run build
npm start
```

For development:

```bash
npm run dev
```

Open `http://localhost:4020/` for the static admin dashboard. The dashboard
stores the API base URL and API key in browser `localStorage`.

The connector can manage multiple sessions. Each session has its own Telegram
`apiId`, `apiHash`, and saved GramJS `StringSession`. The dashboard can create
that `StringSession` for you by sending a Telegram login code to the account's
phone number, then confirming the code and optional 2FA password.

The optional `TELEGRAM_API_ID`, `TELEGRAM_API_HASH`, and `TELEGRAM_SESSION`
values in `.env` only bootstrap the initial default session, usually `main`.
Additional sessions can be added from the dashboard or the `/api/sessions`
endpoint.

Outbound audio sends are converted with `ffmpeg` to Telegram voice-note format.
Set `TELEGRAM_FFMPEG_PATH` if the binary is not available as `ffmpeg` on `PATH`.

For coding-agent and Inteldesk application integration details, see
[`docs/inteldesk-agent-telegram-connector.md`](docs/inteldesk-agent-telegram-connector.md).

## Auth

All `/api/*` endpoints require:

```txt
Authorization: Bearer TELEGRAM_CONNECTOR_API_KEY
```

`/health` and `/ready` are public.

## API

```txt
GET  /health
GET  /ready

GET  /api/sessions
POST /api/sessions
GET  /api/sessions/:session/status
POST /api/sessions/:session/start
POST /api/sessions/:session/stop
POST /api/sessions/:session/login/code
POST /api/sessions/:session/login/confirm
PATCH /api/sessions/:session
DELETE /api/sessions/:session

POST /api/sessions/:session/messages/text
POST /api/sessions/:session/messages/media

GET  /api/sessions/:session/chats/:chatId/messages
GET  /api/media/:mediaId

GET    /api/webhooks
POST   /api/webhooks
DELETE /api/webhooks/:id
POST   /api/webhooks/:id/test
```

Create a session:

```bash
curl -X POST http://localhost:4020/api/sessions \
  -H "Authorization: Bearer $TELEGRAM_CONNECTOR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "name":"sales",
    "apiId":123456,
    "apiHash":"telegram-api-hash"
  }'
```

Request a Telegram login code:

```bash
curl -X POST http://localhost:4020/api/sessions/sales/login/code \
  -H "Authorization: Bearer $TELEGRAM_CONNECTOR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"phoneNumber":"+15555550123"}'
```

Confirm the login code:

```bash
curl -X POST http://localhost:4020/api/sessions/sales/login/confirm \
  -H "Authorization: Bearer $TELEGRAM_CONNECTOR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"code":"12345"}'
```

If Telegram requires 2FA, the confirm response returns
`"status":"password_required"`. Confirm again with the password:

```bash
curl -X POST http://localhost:4020/api/sessions/sales/login/confirm \
  -H "Authorization: Bearer $TELEGRAM_CONNECTOR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"password":"your-telegram-2fa-password"}'
```

Update session credentials:

```bash
curl -X PATCH http://localhost:4020/api/sessions/sales \
  -H "Authorization: Bearer $TELEGRAM_CONNECTOR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"stringSession":"new-gramjs-string-session"}'
```

Public session responses include `name`, `apiId`, `status`, `lastError`,
timestamps, and `hasStringSession`. They never include `apiHash` or the stored
`StringSession`.

Send text:

```bash
curl -X POST http://localhost:4020/api/sessions/main/messages/text \
  -H "Authorization: Bearer $TELEGRAM_CONNECTOR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"to":{"type":"chat_id","value":"123456789"},"text":"Hello"}'
```

Send media:

```bash
curl -X POST http://localhost:4020/api/sessions/main/messages/media \
  -H "Authorization: Bearer $TELEGRAM_CONNECTOR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"to":{"type":"username","value":"example"},"mediaUrl":"https://example.com/file.jpg","caption":"Optional","type":"image"}'
```

For media sends, the connector downloads `mediaUrl` itself and
uploads the file to Telegram. This lets private or local connector media URLs
work without requiring Telegram's servers to fetch them directly. Audio-like
files and `type:"audio"`/`type:"voice"` requests are converted to Opus OGG voice
notes when `ffmpeg` is available, falling back to the original file if conversion
fails. Use `type:"video"` to mark videos as streamable by default.

Supported recipient types:

```txt
chat_id
username
phone
```

Phone resolution is best effort and depends on Telegram contact/privacy rules.

## Webhooks

For local webhook testing, run the standalone listener:

```bash
npm run webhook:listen
```

By default it listens on `http://127.0.0.1:5050/webhook`, verifies
`X-Telegram-Connector-Signature`, and prints each accepted delivery. Useful
environment overrides:

```bash
WEBHOOK_LISTENER_PORT=5050
WEBHOOK_LISTENER_HOST=127.0.0.1
WEBHOOK_LISTENER_PATH=/webhook
TELEGRAM_CONNECTOR_WEBHOOK_SECRET=dev-webhook-secret
WEBHOOK_VERIFY_SIGNATURE=true
```

Create a webhook:

```bash
curl -X POST http://localhost:4020/api/webhooks \
  -H "Authorization: Bearer $TELEGRAM_CONNECTOR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "url":"https://inteldesk.example.com/api/providers/telegram/webhook",
    "events":["message.received","message.edited","message.deleted","message.sent","session.status","session.error"],
    "secret":"replace-with-webhook-secret",
    "session":"main"
  }'
```

Webhook envelope:

```json
{
  "provider": "telegram",
  "event": "message.received",
  "session": "main",
  "timestamp": "2026-07-27T18:00:00.000Z",
  "payload": {}
}
```

Headers:

```txt
X-Telegram-Connector-Event
X-Telegram-Connector-Delivery
X-Telegram-Connector-Timestamp
X-Telegram-Connector-Signature
```

Signature:

```txt
HMAC-SHA256(secret, timestamp + "." + rawBody)
```

The header value is prefixed with `sha256=`.

## Media

Inbound media is downloaded to `MEDIA_STORAGE_DIR` when
`TELEGRAM_DOWNLOAD_INBOUND_MEDIA=true`. Webhooks include a protected connector
download URL:

```json
{
  "media": {
    "id": "media-id",
    "mimeType": "image/jpeg",
    "fileName": "photo.jpg",
    "size": 123456,
    "downloadUrl": "https://telegram-connector.example.com/api/media/media-id"
  }
}
```

## Deployment Notes

Run only one connector instance per Telegram session. Two processes using the
same GramJS session can conflict.

For PM2:

```bash
npm run build
pm2 start dist/index.js --name telegram-connector
```

For systemd or containers, make sure `data/` and `media/` are persisted.
Set `SERVER_HOST=0.0.0.0` when the connector needs to listen outside localhost.

## Tests

```bash
npm test
```
