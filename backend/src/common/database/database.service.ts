import { Inject, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { Pool, QueryResult, QueryResultRow } from 'pg';
import { PG_POOL } from './database.constants';

/**
 * Thin wrapper around the Core DB connection pool. Every query goes through here rather
 * than callers reaching for `PG_POOL` directly, so connectivity checks (`ping`) and the
 * "not configured" error message stay in one place.
 */
@Injectable()
export class DatabaseService implements OnModuleDestroy {
  private readonly logger = new Logger(DatabaseService.name);

  constructor(@Inject(PG_POOL) private readonly pool: Pool | null) {}

  get isConfigured(): boolean {
    return this.pool !== null;
  }

  getPool(): Pool {
    if (!this.pool) {
      throw new Error(
        'PostgreSQL is not configured — set DATABASE_URL (or DB_HOST/DB_NAME) to enable it',
      );
    }
    return this.pool;
  }

  async query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    params?: unknown[],
  ): Promise<QueryResult<T>> {
    return this.getPool().query<T>(text, params);
  }

  /**
   * Cheap connectivity check for the health endpoint. Returns `false` rather than
   * throwing on any failure — including "not configured", since Postgres is currently
   * optional infrastructure and an absent pool shouldn't itself look like an outage.
   */
  async ping(): Promise<boolean> {
    if (!this.pool) return false;
    try {
      await this.pool.query('SELECT 1');
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
  }
}
