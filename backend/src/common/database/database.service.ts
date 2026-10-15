import { Inject, Injectable, OnModuleDestroy, Optional } from '@nestjs/common';
import { SanitizedLogger } from '../logging/sanitized-logger';
import { redactError } from '../logging/redaction';
import { Pool, QueryResult, QueryResultRow } from 'pg';
import { PG_POOL, PG_READ_POOLS } from './database.constants';

import { MetricsService } from '../../monitoring/metrics.service';
import { DatabaseQueryLoggerService } from '../../monitoring/database-query-logger.service';

/**
 * Thin wrapper around the Core DB connection pool. Every query goes through here rather
 * than callers reaching for `PG_POOL` directly, so connectivity checks (`ping`) and the
 * "not configured" error message stay in one place.
 *
 * Read/write splitting
 * --------------------
 * - `query()` — always routes to the **primary** pool. Use for all INSERT/UPDATE/DELETE
 *   and any SELECT that must observe the most recent writes.
 * - `queryRead()` — routes to a read-replica pool selected in round-robin order.
 *   Falls back transparently to the primary when no replicas are configured or available,
 *   so callers never need to handle the "no replica" case themselves.
 *
 * Replicas are provisioned by `DatabaseModule` via the `PG_READ_POOLS` injection token,
 * which resolves to `null` when `DATABASE_READ_REPLICAS` is not set.
 */
@Injectable()
export class DatabaseService implements OnModuleDestroy {
  private readonly logger = new SanitizedLogger(DatabaseService.name);
  private readonly slowQueryThresholdMs = 500;

  /** Round-robin cursor for replica pool selection. */
  private replicaCursor = 0;

  constructor(
    @Inject(PG_POOL) private readonly pool: Pool | null,
    @Optional() @Inject(PG_READ_POOLS) private readonly readPools: Pool[] | null,
    @Optional() private readonly metrics?: MetricsService,
    @Optional() private readonly queryLogger?: DatabaseQueryLoggerService,
  ) {}

  get isConfigured(): boolean {
    return this.pool !== null;
  }

  /** Returns true when at least one read-replica pool is available. */
  get hasReplicas(): boolean {
    return Array.isArray(this.readPools) && this.readPools.length > 0;
  }

  getPool(): Pool {
    if (!this.pool) {
      throw new Error(
        'PostgreSQL is not configured — set DATABASE_URL (or DB_HOST/DB_NAME) to enable it',
      );
    }
    return this.pool;
  }

  /**
   * Returns the next read-replica pool in round-robin order.
   * Falls back to the primary pool when no replicas are configured.
   */
  private getReadPool(): Pool {
    if (!this.readPools || this.readPools.length === 0) {
      return this.getPool();
    }
    const pool = this.readPools[this.replicaCursor % this.readPools.length];
    this.replicaCursor = (this.replicaCursor + 1) % this.readPools.length;
    return pool;
  }

  /**
   * Execute a query on the **primary** (write) pool.
   * Use for all mutating statements and reads that require strong consistency.
   */
  async query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    params?: unknown[],
  ): Promise<QueryResult<T>> {
    return this.runQuery(this.getPool(), text, params, 'primary');
  }

  /**
   * Execute a read-only query on a **replica** pool (round-robin).
   * Falls back to the primary pool when no replicas are configured.
   *
   * Only use for SELECT statements that do not need to observe the latest writes
   * from the current request — e.g. analytics aggregations, list endpoints.
   */
  async queryRead<T extends QueryResultRow = QueryResultRow>(
    text: string,
    params?: unknown[],
  ): Promise<QueryResult<T>> {
    return this.runQuery(
      this.getReadPool(),
      text,
      params,
      this.hasReplicas ? 'replica' : 'primary',
    );
  }

  private async runQuery<T extends QueryResultRow = QueryResultRow>(
    pool: Pool,
    text: string,
    params: unknown[] | undefined,
    poolLabel: string,
  ): Promise<QueryResult<T>> {
    const startTime = performance.now();
    try {
      const result = await pool.query<T>(text, params);
      const duration = performance.now() - startTime;

      this.logger.debug(`Query [${poolLabel}] executed in ${duration.toFixed(2)}ms`);
      if (this.metrics) {
        this.metrics.increment('db_query_count');
      }

      // Use dedicated query logger for slow query detection and metrics
      if (this.queryLogger) {
        this.queryLogger.logQuery(text, duration, poolLabel);
      } else if (duration > this.slowQueryThresholdMs) {
        // Fallback to old behavior if query logger not available
        this.logger.warn(
          `Slow query [${poolLabel}] detected: ${duration.toFixed(2)}ms\nQuery: ${this.describeQuery(text)}`,
        );
        if (this.metrics) {
          this.metrics.increment('db_slow_query_count');
        }
      }
      return result;
    } catch (error) {
      const duration = performance.now() - startTime;
      this.logger.error(
        `Query [${poolLabel}] failed after ${duration.toFixed(2)}ms\nQuery: ${this.describeQuery(text)}\nReason: ${redactError(error)}`,
      );
      if (this.metrics) {
        this.metrics.increment('db_query_error_count');
      }
      throw error;
    }
  }

  /**
   * Reduces a SQL statement to a loggable shape: literals are replaced with `?` and the whole
   * string is truncated.
   */
  private describeQuery(text: string): string {
    const withoutLiterals = text
      .replace(/'(?:[^']|'')*'/g, '?')
      .replace(/\b\d+\.\d+\b/g, '?')
      .replace(/\b\d+\b/g, '?')
      .replace(/\$\d+/g, '?');
    return withoutLiterals.length > 200 ? `${withoutLiterals.slice(0, 200)}…` : withoutLiterals;
  }

  /**
   * Cheap connectivity check for the health endpoint. Pings both primary and
   * all configured replicas; returns `false` if the primary is unreachable.
   */
  async ping(): Promise<boolean> {
    if (!this.pool) return false;
    try {
      await this.pool.query('SELECT 1');
      // Also ping replicas so health checks surface degraded replica state
      if (this.readPools) {
        await Promise.allSettled(this.readPools.map(p => p.query('SELECT 1')));
      }
      return true;
    } catch (error) {
      this.logger.error(
        'PostgreSQL health check failed',
        error instanceof Error ? error.stack : String(error),
      );
      return false;
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (this.pool) await this.pool.end();
    if (this.readPools) {
      await Promise.allSettled(this.readPools.map(p => p.end()));
    }
  }
}
