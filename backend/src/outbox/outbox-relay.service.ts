import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { SanitizedLogger } from '../common/logging/sanitized-logger';
import { MetricsService } from '../monitoring/metrics.service';
import { WebhookService } from '../webhook/webhook.service';
import { OutboxPublisherService } from './outbox-publisher.service';
import { OutboxService } from './outbox.service';
import { OutboxEventDispatcher } from './outbox-event-dispatcher.service';
import { config } from '../config/env.config';
import { CorrelationIdStore } from '../common/logging/correlation-id.store';
import { runWithRequestContext } from '../common/logging/request-context';
import { Optional } from '@nestjs/common';

/** Background relay for at-least-once outbox delivery. */
@Injectable()
export class OutboxRelayService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new SanitizedLogger(OutboxRelayService.name);
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly outbox: OutboxService,
    private readonly publisher: OutboxPublisherService,
    private readonly webhookService: WebhookService,
    private readonly dispatcher: OutboxEventDispatcher,
    private readonly metrics: MetricsService,
    @Optional() private readonly correlationIdStore?: CorrelationIdStore,
  ) {}

  onModuleInit(): void {
    const interval = config.OUTBOX_RELAY_INTERVAL_MS;
    if (interval <= 0) return;
    this.timer = setInterval(() => {
      this.runOnce().catch(error => this.logger.error('Outbox relay failed', error));
    }, interval);
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async runOnce(): Promise<number> {
    const now = Date.now();
    const batchSize = config.OUTBOX_RELAY_BATCH_SIZE;
    const leaseMs = config.OUTBOX_RELAY_LEASE_MS;
    await this.outbox.reclaimExpired(now, batchSize);
    const events = await this.outbox.claimDue(now, leaseMs, batchSize);

    for (const event of events) {
      const executeEvent = async () => {
        try {
          // Publish first. If a later destination fails, redelivery is expected;
          // all destinations receive the stable dedupKey to collapse duplicates.
          await this.publisher.publish(event);
          // Skip sendWebhook for events that are already webhook fan-outs to prevent
          // perpetual re-spawning of webhook events into the same queue (#792).
          if (event.aggregateType !== 'webhook') {
            this.outbox.sendWebhook(null, event.type, event.payload, event.dedupKey);
          }
          await this.dispatcher.dispatch(event);
          await this.outbox.markDelivered(event);
          this.metrics.increment('outbox_delivery_total', { result: 'delivered', type: event.type });
        } catch (error) {
          await this.outbox.retry(event, error);
          this.metrics.increment('outbox_delivery_total', {
            result: event.status === 'failed' ? 'failed' : 'retry',
            type: event.type,
          });
        }
      };

      if (event.correlationId) {
        if (this.correlationIdStore) {
          await this.correlationIdStore.run(event.correlationId, () =>
            runWithRequestContext(event.correlationId!, executeEvent),
          );
        } else {
          await runWithRequestContext(event.correlationId, executeEvent);
        }
      } else {
        await executeEvent();
      }
    }

    return events.length;
  }
}
