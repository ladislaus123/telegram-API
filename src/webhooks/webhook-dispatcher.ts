import crypto from 'node:crypto';
import { Logger } from 'pino';
import { AppConfig } from '../config';
import { SqliteStore } from '../storage/sqlite-store';
import {
  TelegramConnectorEvent,
  WebhookEvent,
  WebhookSubscription,
} from '../types';
import { createWebhookSignature } from './webhook-signature';

export class WebhookDispatcher {
  constructor(
    private readonly store: SqliteStore,
    private readonly config: Pick<AppConfig, 'webhooks'>,
    private readonly logger: Logger,
  ) {}

  dispatch<TPayload>(event: TelegramConnectorEvent<TPayload>): void {
    const webhooks = this.store.listMatchingWebhooks(event.event, event.session);
    for (const webhook of webhooks) {
      const deliveryId = crypto.randomUUID();
      this.store.createDelivery({
        id: deliveryId,
        webhookId: webhook.id,
        event: event.event,
        session: event.session,
      });

      void this.deliverWithRetries(deliveryId, webhook, event).catch((error) => {
        this.logger.error({ error, deliveryId }, 'Webhook delivery failed');
      });
    }
  }

  async dispatchTest(webhook: WebhookSubscription): Promise<void> {
    const event: TelegramConnectorEvent = {
      provider: 'telegram',
      event: 'session.status',
      session: webhook.session ?? 'main',
      timestamp: new Date().toISOString(),
      payload: {
        status: 'test',
      },
    };

    const deliveryId = crypto.randomUUID();
    this.store.createDelivery({
      id: deliveryId,
      webhookId: webhook.id,
      event: event.event,
      session: event.session,
    });
    await this.deliverWithRetries(deliveryId, webhook, event);
  }

  private async deliverWithRetries<TPayload>(
    deliveryId: string,
    webhook: WebhookSubscription,
    event: TelegramConnectorEvent<TPayload>,
  ): Promise<void> {
    let lastError: string | null = null;
    let lastStatusCode: number | null = null;

    for (let attempt = 1; attempt <= this.config.webhooks.maxAttempts; attempt++) {
      if (attempt > 1) {
        await this.sleep(this.retryDelayMs(attempt));
      }

      const timestamp = new Date().toISOString();
      const body = JSON.stringify({
        ...event,
        timestamp,
      });
      const signature = createWebhookSignature(webhook.secret, timestamp, body);

      try {
        const response = await fetch(webhook.url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-telegram-connector-event': event.event,
            'x-telegram-connector-delivery': deliveryId,
            'x-telegram-connector-timestamp': timestamp,
            'x-telegram-connector-signature': signature,
          },
          body,
        });

        lastStatusCode = response.status;
        if (response.ok) {
          this.store.updateDelivery(deliveryId, {
            attempts: attempt,
            status: 'delivered',
            statusCode: response.status,
            error: null,
            nextAttemptAt: null,
          });
          return;
        }

        lastError = `HTTP ${response.status}: ${await response.text()}`;
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
      }

      const hasMoreAttempts = attempt < this.config.webhooks.maxAttempts;
      this.store.updateDelivery(deliveryId, {
        attempts: attempt,
        status: hasMoreAttempts ? 'pending' : 'failed',
        statusCode: lastStatusCode,
        error: lastError,
        nextAttemptAt: hasMoreAttempts
          ? new Date(Date.now() + this.retryDelayMs(attempt + 1)).toISOString()
          : null,
      });
    }
  }

  private retryDelayMs(attempt: number): number {
    return this.config.webhooks.retryBaseMs * 2 ** Math.max(0, attempt - 2);
  }

  private async sleep(delayMs: number): Promise<void> {
    if (delayMs <= 0) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
}
