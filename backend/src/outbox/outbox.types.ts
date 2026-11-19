export type OutboxStatus = 'pending' | 'processing' | 'retrying' | 'delivered' | 'failed';

/**
 * Durable domain event. `dedupKey` is stable across retries so every consumer
 * can perform idempotent processing while the relay provides at-least-once
 * delivery.
 */
export interface OutboxEvent<T = unknown> {
  id: string;
  dedupKey: string;
  type: string;
  aggregateType: string;
  aggregateId: string;
  payload: T;
  status: OutboxStatus;
  attempts: number;
  nextAttemptAt: number;
  createdAt: string;
  deliveredAt?: string;
  lastError?: string;
  correlationId?: string;
}

/** The subset of Redis MULTI commands used when appending an outbox row. */
export interface OutboxTransaction {
  set(key: string, value: string): OutboxTransaction;
  zadd(key: string, score: number, member: string): OutboxTransaction;
}
