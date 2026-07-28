import crypto from 'node:crypto';

export function createWebhookSignature(
  secret: string,
  timestamp: string,
  rawBody: string,
): string {
  const digest = crypto
    .createHmac('sha256', secret)
    .update(`${timestamp}.${rawBody}`)
    .digest('hex');
  return `sha256=${digest}`;
}
