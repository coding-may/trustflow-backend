import { Global, Logger, Module } from '@nestjs/common';
import { Pool, PoolConfig } from 'pg';
import { DatabaseService } from './database.service';
import { PG_POOL } from './database.constants';

export { PG_POOL } from './database.constants';

const DEFAULT_POOL_MAX = 10;
const DEFAULT_IDLE_TIMEOUT_MS = 30_000;
const DEFAULT_CONNECTION_TIMEOUT_MS = 5_000;
const DEFAULT_PORT = 5432;

function positiveIntOr(raw: string | undefined, fallback: number): number {
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

/**
 * Builds the pool config from environment variables. Returns `null` when neither
 * `DATABASE_URL` nor the discrete `DB_HOST`/`DB_NAME` pair is set, mirroring how
 * RedisModule degrades to a `null` client when `REDIS_URL` is unset — Postgres is
 * optional infrastructure here, not (yet) a hard dependency of any service.
 */
export function buildPoolConfig(env: NodeJS.ProcessEnv = process.env): PoolConfig | null {
  const connectionString = env.DATABASE_URL;
  const host = env.DB_HOST;
  const database = env.DB_NAME;

  if (!connectionString && !(host && database)) return null;

  const base: PoolConfig = {
    max: positiveIntOr(env.DB_POOL_MAX, DEFAULT_POOL_MAX),
    idleTimeoutMillis: positiveIntOr(env.DB_POOL_IDLE_TIMEOUT_MS, DEFAULT_IDLE_TIMEOUT_MS),
    connectionTimeoutMillis: positiveIntOr(
      env.DB_POOL_CONNECTION_TIMEOUT_MS,
      DEFAULT_CONNECTION_TIMEOUT_MS,
    ),
    ssl: env.DB_SSL === 'true' ? { rejectUnauthorized: false } : undefined,
  };

  if (connectionString) return { ...base, connectionString };

  return {
    ...base,
    host,
    port: positiveIntOr(env.DB_PORT, DEFAULT_PORT),
    database,
    user: env.DB_USER,
    password: env.DB_PASSWORD,
  };
}

/**
 * Connection pool for the Core DB (PostgreSQL). Configured via `DATABASE_URL`, or
 * discrete `DB_HOST`/`DB_PORT`/`DB_NAME`/`DB_USER`/`DB_PASSWORD` env vars — see
 * `.env.example`. When neither is set (the default in dev/test), `PG_POOL` resolves
 * to `null` and `DatabaseService` reports itself as unconfigured rather than throwing,
 * so the app still boots without a local Postgres.
 */
@Global()
@Module({
  providers: [
    {
      provide: PG_POOL,
      useFactory: () => {
        const config = buildPoolConfig();
        if (!config) return null;

        const pool = new Pool(config);
        const logger = new Logger('DatabaseModule');
        // A pool-level client can emit 'error' while idle (e.g. the server restarts) —
        // without this listener, that would crash the process via an unhandled 'error' event.
        pool.on('error', error => {
          logger.error('Unexpected error on an idle PostgreSQL client', error.stack);
        });
        return pool;
      },
    },
    DatabaseService,
  ],
  exports: [PG_POOL, DatabaseService],
})
export class DatabaseModule {}
