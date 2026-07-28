import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeTelegramMessage } from '../telegram/message-normalizer';

test('normalizeTelegramMessage normalizes text messages', async () => {
  const payload = await normalizeTelegramMessage({
    session: 'main',
    client: {} as any,
    message: {
      id: 123,
      chatId: { toString: () => '987' },
      senderId: { toString: () => '456' },
      date: 1785175200,
      out: false,
      message: 'hello',
      text: 'hello',
      getSender: async () => ({
        id: { toString: () => '456' },
        username: 'john',
        firstName: 'John',
        lastName: 'Doe',
        phone: '15555550123',
      }),
      getChat: async () => ({
        id: { toString: () => '987' },
        phone: '+15555550987',
      }),
    } as any,
  });

  assert.equal(payload.messageId, '123');
  assert.equal(payload.chatId, '987');
  assert.equal(payload.chatPhone, '+15555550987');
  assert.equal(payload.senderId, '456');
  assert.equal(payload.senderPhone, '+15555550123');
  assert.equal(payload.username, 'john');
  assert.equal(payload.displayName, 'John Doe');
  assert.equal(payload.type, 'text');
  assert.equal(payload.text, 'hello');
  assert.equal(payload.media, null);
});

test('normalizeTelegramMessage supports media payloads from media store', async () => {
  const mediaPayload = {
    id: 'media-id',
    mimeType: 'image/jpeg',
    fileName: 'photo.jpg',
    size: 10,
    downloadUrl: 'http://localhost/api/media/media-id',
  };

  const payload = await normalizeTelegramMessage({
    session: 'main',
    client: {} as any,
    mediaStore: {
      storeIncomingMedia: async () => mediaPayload,
    } as any,
    downloadMedia: true,
    message: {
      id: 124,
      chatId: { toString: () => '987' },
      senderId: { toString: () => '456' },
      date: 1785175200,
      out: false,
      message: '',
      text: '',
      media: {},
      photo: {},
      getSender: async () => undefined,
    } as any,
  });

  assert.equal(payload.type, 'image');
  assert.deepEqual(payload.media, mediaPayload);
});

test('normalizeTelegramMessage marks outbound messages', async () => {
  const payload = await normalizeTelegramMessage({
    session: 'main',
    client: {} as any,
    message: {
      id: 125,
      chatId: { toString: () => '987' },
      senderId: { toString: () => '456' },
      date: 1785175200,
      out: true,
      message: 'sent',
      text: 'sent',
    } as any,
  });

  assert.equal(payload.fromMe, true);
});

test('normalizeTelegramMessage uses sender phone as chat phone for direct chats', async () => {
  const payload = await normalizeTelegramMessage({
    session: 'main',
    client: {} as any,
    message: {
      id: 126,
      chatId: { toString: () => '456' },
      senderId: { toString: () => '456' },
      date: 1785175200,
      out: false,
      message: 'direct',
      text: 'direct',
      getSender: async () => ({
        id: { toString: () => '456' },
        firstName: 'Jane',
        phone: '15555550124',
      }),
    } as any,
  });

  assert.equal(payload.chatPhone, '+15555550124');
  assert.equal(payload.senderPhone, '+15555550124');
});
