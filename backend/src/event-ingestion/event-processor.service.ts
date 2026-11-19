import { Inject, Injectable, OnModuleInit, Optional } from '@nestjs/common';
import { SanitizedLogger } from '../common/logging/sanitized-logger';
import { Redis } from 'ioredis';
import { REDIS_CLIENT } from '../common/redis/redis.module';
import { MetricsService } from '../monitoring/metrics.service';
import { EscrowService, Escrow } from '../escrow/escrow.service';
import { DisputeSagaService } from '../dispute/dispute-saga.service';
import { config } from '../config/env.config';

export interface SorobanEvent {
  id: string;
  ledger: number;
  contractId: string;
  eventType: string;
  topic: string[];
  /** Raw decoded XDR value — type depends on event schema; callers narrow before use. */
  value: Record<string, unknown>;
  xdr: string;
  createdAt: Date;
  /** Transaction hash, when the RPC response exposes it. */
  txHash?: string;
}

export interface ProcessedEvent {
  eventId: string;
  ledger: number;
  success: boolean;
  error?: string;
  processedAt: Date;
  // Store original event data for retry
  originalEvent?: SorobanEvent;
  /**
   * Identity of the individual event that failed within a batch. A batch-level
   * ledger range is not enough to locate the offending event — operators need
   * the transaction hash and event index to reprocess a single event.
   */
  txHash?: string;
  eventIndex?: number;
}

/** Counter of events actually applied to the read model — one increment per successful event. */
export const EVENTS_INGESTED_TOTAL = 'events_ingested_total';
/** Counter of events that failed and were written to dead-letter — one increment per failed event. */
export const EVENTS_DEAD_LETTERED_TOTAL = 'events_dead_lettered_total';

/**
 * Derive the transaction hash and event index of a Soroban event for dead-letter records.
 *
 * RPC responses sometimes expose `txHash` directly; otherwise it is encoded in the event id
 * (`<ledger>-<txIndex>-<eventIndex>`, each group hex-encoded). Returning both lets operators
 * pinpoint the exact event inside a failed batch instead of bisecting the whole batch.
 */
export function getEventIdentity(event: SorobanEvent): { txHash?: string; eventIndex?: number } {
  const segments = event.id?.split('-') ?? [];
  const last = segments[segments.length - 1];
  const parsedIndex = last === undefined ? NaN : Number.parseInt(last, 16);

  return {
    txHash: event.txHash ?? (segments.length > 1 ? segments.slice(0, -1).join('-') : undefined),
    eventIndex: Number.isFinite(parsedIndex) ? parsedIndex : undefined,
  };
}

const EVENT_KEY_PREFIX = 'processed-event:';
const EVENTS_INDEX_KEY = 'processed-events:index';

/** Emitted (see `GET /metrics`) every time a call falls back to the in-memory store. */
export const EVENT_PROCESSOR_PERSISTENCE_FALLBACK_METRIC =
  'event_processor_persistence_fallback_total';

/**
 * Reorg-safety dedup log gating whether a Soroban event has already been processed. Backed by
 * Redis so it survives restarts and is shared across instances — see
 * PERSISTENT_STORAGE_SPIKE.md and its "Follow-up decisions" addendum (#190). Losing this log on
 * restart previously risked double-processing events ingested just before the restart; a value
 * round-tripped through Redis is byte-for-byte the same value that used to live in the Map, so
 * reorg-safety semantics are otherwise unaffected by this migration.
 *
 * Falls back to a process-local Map when Redis is unavailable, logged at `error` level and
 * counted via `EVENT_PROCESSOR_PERSISTENCE_FALLBACK_METRIC`.
 */
@Injectable()
export class EventProcessorService implements OnModuleInit {
  private readonly logger = new SanitizedLogger(EventProcessorService.name);
  /** Fallback store, only used while Redis is unavailable. */
  private processedEvents: Map<string, ProcessedEvent> = new Map();

  constructor(
    private readonly escrowService: EscrowService,
    @Optional() @Inject(REDIS_CLIENT) private readonly redis: Redis | null = null,
    @Optional() private readonly metrics?: MetricsService,
    @Optional() private readonly disputeSagaService?: DisputeSagaService,
  ) {}

  onModuleInit(): void {
    if (!this.redis && config.NODE_ENV === 'production') {
      throw new Error(
        'EventProcessorService requires REDIS_URL to be configured in production — refusing ' +
          'to start with per-instance in-memory storage, which would silently diverge across instances.',
      );
    }
  }

  async processEvent(event: SorobanEvent): Promise<ProcessedEvent> {
    const eventId = `${event.ledger}-${event.id}`;

    const existing = await this.tryGet(eventId);
    if (existing) {
      this.logger.warn(`Event ${eventId} already processed, skipping`);
      return existing;
    }

    try {
      await this.applyEvent(event);

      const result: ProcessedEvent = {
        eventId,
        ledger: event.ledger,
        success: true,
        processedAt: new Date(),
        originalEvent: event,
      };

      await this.persist(result);
      // Count the event, not the batch: a batch is "ingested" only if every event in it was.
      this.metrics?.increment(EVENTS_INGESTED_TOTAL, { event_type: event.eventType });
      this.logger.log(`Event ${eventId} processed successfully`);
      return result;
    } catch (error) {
      const identity = getEventIdentity(event);
      const result: ProcessedEvent = {
        eventId,
        ledger: event.ledger,
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        processedAt: new Date(),
        originalEvent: event,
        ...identity,
      };

      await this.persist(result);
      this.metrics?.increment(EVENTS_DEAD_LETTERED_TOTAL, { event_type: event.eventType });
      this.logger.error(
        `Event ${eventId} failed (tx=${identity.txHash ?? 'unknown'}, ` +
          `eventIndex=${identity.eventIndex ?? 'unknown'}): ${result.error}`,
      );
      return result;
    }
  }

  private async applyEvent(event: SorobanEvent): Promise<void> {
    switch (event.eventType) {
      case 'escrow_created':
        await this.handleEscrowCreated(event);
        break;
      case 'escrow_funded':
        await this.handleEscrowFunded(event);
        break;
      case 'escrow_released':
        await this.handleEscrowReleased(event);
        break;
      case 'escrow_disputed':
        await this.handleEscrowDisputed(event);
        break;
      default:
        this.logger.warn(`Unknown event type: ${event.eventType}`);
    }
  }

  private async handleEscrowCreated(event: SorobanEvent): Promise<void> {
    const { depositor, beneficiary, amount } = event.value as {
      depositor: string;
      beneficiary: string;
      amount: string;
    };
    const contractEscrowId = this.getContractEscrowId(event);
    const existing = await this.escrowService.findByContractEscrowId(contractEscrowId);
    if (existing) {
      this.logger.warn(`Escrow ${contractEscrowId} already linked to DB row ${existing.id}`);
      return;
    }

    await this.escrowService.createFromChainState({
      contractEscrowId,
      depositor,
      beneficiary,
      amountXLM: amount,
      status: 'pending',
    });
    this.logger.log(`Escrow created: ${contractEscrowId}`);
  }

  private async handleEscrowFunded(event: SorobanEvent): Promise<void> {
    const escrow = await this.resolveEscrowByContractId(event);
    await this.escrowService.fund(escrow.id);
    this.logger.log(`Escrow funded: ${escrow.contractEscrowId}`);
  }

  private async handleEscrowReleased(event: SorobanEvent): Promise<void> {
    const escrow = await this.resolveEscrowByContractId(event);
    await this.escrowService.release(escrow.id);
    this.logger.log(`Escrow released: ${escrow.contractEscrowId}`);
  }

  private async handleEscrowDisputed(event: SorobanEvent): Promise<void> {
    const escrow = await this.resolveEscrowByContractId(event);
    const reason = (event.value.reason as string | undefined) ?? 'Dispute raised on-chain';
    if (this.disputeSagaService) {
      await this.disputeSagaService.escalateFromChain(escrow.id, reason);
      this.logger.log(`Escrow disputed via saga: ${escrow.contractEscrowId}`);
      return;
    }
    await this.escrowService.raiseDispute(escrow.id, reason);
    this.logger.log(`Escrow disputed: ${escrow.contractEscrowId}`);
  }

  private async resolveEscrowByContractId(event: SorobanEvent): Promise<Escrow> {
    const contractEscrowId = this.getContractEscrowId(event);
    const escrow = await this.escrowService.findByContractEscrowId(contractEscrowId);
    if (!escrow) {
      throw new Error(`No DB escrow linked to contract escrow id ${contractEscrowId}`);
    }
    return escrow;
  }

  private getContractEscrowId(event: SorobanEvent): string {
    const value = event.value;
    const candidate = value.contractEscrowId ?? value.escrowId ?? event.topic[1] ?? event.id;
    if (typeof candidate !== 'string' || candidate.trim() === '') {
      throw new Error(`Missing contract escrow id for ${event.eventType} event ${event.id}`);
    }
    return candidate;
  }

  async isEventProcessed(eventId: string): Promise<boolean> {
    return (await this.tryGet(eventId)) !== undefined;
  }

  async getProcessedEventsByLedger(ledger: number): Promise<ProcessedEvent[]> {
    return (await this.fetchAll()).filter(e => e.ledger === ledger);
  }

  async getFailedEvents(): Promise<ProcessedEvent[]> {
    return (await this.fetchAll()).filter(e => !e.success);
  }

  async clearEventsBeforeLedger(ledger: number): Promise<number> {
    const all = await this.fetchAll();
    const toClear = all.filter(e => e.ledger < ledger);
    if (toClear.length === 0) return 0;

    if (this.redis) {
      try {
        await this.redis
          .multi()
          .del(...toClear.map(e => this.eventKey(e.eventId)))
          .srem(EVENTS_INDEX_KEY, ...toClear.map(e => e.eventId))
          .exec();
        return toClear.length;
      } catch (err) {
        this.logFallback('clearEventsBeforeLedger', err);
      }
    }

    for (const event of toClear) {
      this.processedEvents.delete(event.eventId);
    }
    return toClear.length;
  }

  async clearEventsFromLedger(ledger: number): Promise<number> {
    const all = await this.fetchAll();
    const toClear = all.filter(e => e.ledger >= ledger);
    if (toClear.length === 0) return 0;

    if (this.redis) {
      try {
        await this.redis
          .multi()
          .del(...toClear.map(e => this.eventKey(e.eventId)))
          .srem(EVENTS_INDEX_KEY, ...toClear.map(e => e.eventId))
          .exec();
        return toClear.length;
      } catch (err) {
        this.logFallback('clearEventsFromLedger', err);
      }
    }

    for (const event of toClear) {
      this.processedEvents.delete(event.eventId);
    }
    return toClear.length;
  }

  async retryFailedEvents(): Promise<ProcessedEvent[]> {
    const failed = await this.getFailedEvents();
    const results: ProcessedEvent[] = [];

    for (const failedRecord of failed) {
      if (!failedRecord.originalEvent) {
        this.logger.warn(
          `Failed event ${failedRecord.eventId} has no originalEvent, skipping retry`,
        );
        continue;
      }

      // Clear the failed record so it's not considered already processed
      await this.clearEventById(failedRecord.eventId);

      // Re-run the event handler
      const retried = await this.processEvent(failedRecord.originalEvent);
      results.push(retried);
    }

    return results;
  }

  private async clearEventById(eventId: string): Promise<void> {
    if (this.redis) {
      try {
        await this.redis.multi().del(this.eventKey(eventId)).srem(EVENTS_INDEX_KEY, eventId).exec();
        return;
      } catch (err) {
        this.logFallback('clearEventById', err);
      }
    }

    this.processedEvents.delete(eventId);
  }

  // ─── Persistence helpers ────────────────────────────────────────────

  private async persist(result: ProcessedEvent): Promise<void> {
    if (this.redis) {
      try {
        const results = await this.redis
          .multi()
          .set(this.eventKey(result.eventId), JSON.stringify(result))
          .sadd(EVENTS_INDEX_KEY, result.eventId)
          .exec();
        this.assertTransactionOk(results);
        return;
      } catch (err) {
        this.logFallback('persist', err);
      }
    }

    this.processedEvents.set(result.eventId, result);
  }

  private async tryGet(eventId: string): Promise<ProcessedEvent | undefined> {
    if (this.redis) {
      try {
        const raw = await this.redis.get(this.eventKey(eventId));
        return raw ? (JSON.parse(raw) as ProcessedEvent) : undefined;
      } catch (err) {
        this.logFallback('isEventProcessed', err);
      }
    }

    return this.processedEvents.get(eventId);
  }

  private async fetchAll(): Promise<ProcessedEvent[]> {
    if (this.redis) {
      try {
        const ids = await this.redis.smembers(EVENTS_INDEX_KEY);
        if (ids.length === 0) return [];
        const raw = await this.redis.mget(...ids.map(id => this.eventKey(id)));
        return raw.filter((r): r is string => r !== null).map(r => JSON.parse(r) as ProcessedEvent);
      } catch (err) {
        this.logFallback('fetchAll', err);
      }
    }

    return [...this.processedEvents.values()];
  }

  private assertTransactionOk(results: Array<[Error | null, unknown]> | null): void {
    if (!results) {
      throw new Error('Redis transaction aborted (exec() returned null, e.g. a WATCH conflict)');
    }
    const failed = results.find(([err]) => err);
    if (failed) {
      throw new Error(`Redis transaction command failed: ${failed[0]!.message}`);
    }
  }

  private eventKey(eventId: string): string {
    return `${EVENT_KEY_PREFIX}${eventId}`;
  }

  private logFallback(operation: string, err: unknown): void {
    this.metrics?.increment(EVENT_PROCESSOR_PERSISTENCE_FALLBACK_METRIC, { operation });
    this.logger.error(
      `Redis unavailable for eventProcessor.${operation}, falling back to per-instance memory ` +
        '(multi-instance state will diverge until Redis recovers)',
      err instanceof Error ? err.stack : String(err),
    );
  }
}
