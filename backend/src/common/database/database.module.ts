import { Global, Logger, Module } from '@nestjs/common';
import { SanitizedLogger } from '../logging/sanitized-logger';
import { readFileSync } from 'fs';
import { ConnectionOptions } from 'tls';
import { Pool, PoolConfig } from 'pg';
import { DatabaseService } from './database.service';
import { PG_POOL, PG_READ_POOLS } from './database.constants';
import { config } from '../../config/env.config';

export { PG_POOL, PG_READ_POOLS } from './database.constants';

const DEFAULT_POOL_MAX = 10;
const DEFAULT_IDLE_TIMEOUT_MS = 30_000;
const DEFAULT_CONNECTION_TIMEOUT_MS = 5_000;
const DEFAULT_PORT = 5432;
const DEFAULT_RETRY_ATTEMPTS = 5;
const DEFAULT_RETRY_BACKOFF_BASE_MS = 1000;

function positiveIntOr(raw: string | undefined, fallback: number): number {
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

/** Reads a PEM value given inline or as a path to a PEM file. */
function readPem(value: string | undefined): string | undefined {
  if (!value || value.trim() === '') return undefined;
  return value.includes('-----BEGIN') ? value : readFileSync(value, 'utf8');
}

/** Sleep for the given number of milliseconds. */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** Retries a function with exponential backoff. */
async function retryWithExponentialBackoff<T>(
  fn: () => Promise<T>,
  maxAttempts: number,
  baseDelayMs: number,
  logger: Pick<Logger, 'log' | 'warn'>,
): Promise<T> {
  let lastError: Error | undefined;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      if (attempt === maxAttempts) break;

      const delayMs = baseDelayMs * Math.pow(2, attempt - 1);
      logger.warn(
        `Database connection attempt ${attempt}/${maxAttempts} failed: ${lastError.message}. ` +
          `Retrying in ${delayMs}ms...`,
      );
      await sleep(delayMs);
    }
  }

  throw lastError || new Error('Database connection failed after all retries');
}

/**
 * TLS options for the pool. `DB_SSL=true` verifies the server certificate (against the system
 * roots, or `DB_SSL_CA` when given). Verification can only be switched off explicitly with
 * `DB_SSL_REJECT_UNAUTHORIZED=false`, which is logged loudly and refused in production.
 */
export function buildSslConfig(
  env: NodeJS.ProcessEnv,
  logger: Pick<Logger, 'warn'> = new SanitizedLogger('DatabaseModule'),
): ConnectionOptions | undefined {
  if (env.DB_SSL !== 'true') return undefined;

  const rejectUnauthorized = env.DB_SSL_REJECT_UNAUTHORIZED !== 'false';
  if (!rejectUnauthorized) {
    if (env.NODE_ENV === 'production') {
      throw new Error('DB_SSL_REJECT_UNAUTHORIZED=false is not allowed when NODE_ENV=production');
    }
    logger.warn(
      'DB_SSL_REJECT_UNAUTHORIZED=false: PostgreSQL server certificates are NOT verified. ' +
        'The connection is encrypted but not authenticated; do not use this outside local development.',
    );
  }

  const ssl: ConnectionOptions = { rejectUnauthorized };
  const ca = readPem(env.DB_SSL_CA);
  const cert = readPem(env.DB_SSL_CERT);
  const key = readPem(env.DB_SSL_KEY);
  if (ca) ssl.ca = ca;
  if (cert) ssl.cert = cert;
  if (key) ssl.key = key;
  return ssl;
}

/**
 * Builds the pool config from environment variables. Returns `null` when neither
 * `DATABASE_URL` nor the discrete `DB_HOST`/`DB_NAME` pair is set, mirroring how
 * RedisModule degrades to a `null` client when `REDIS_URL` is unset — Postgres is
 * optional infrastructure here, not (yet) a hard dependency of any service.
 */
export function buildPoolConfig(env?: NodeJS.ProcessEnv): PoolConfig | null {
  const source: NodeJS.ProcessEnv = env ?? {
    NODE_ENV: config.NODE_ENV,
    DATABASE_URL: config.DATABASE_URL,
    DB_HOST: config.DB_HOST,
    DB_PORT: String(config.DB_PORT ?? DEFAULT_PORT),
    DB_NAME: config.DB_NAME,
    DB_USER: config.DB_USER,
    DB_PASSWORD: config.DB_PASSWORD,
    DB_SSL: config.DB_SSL ?? 'false',
    DB_SSL_CA: config.DB_SSL_CA,
    DB_SSL_CERT: config.DB_SSL_CERT,
    DB_SSL_KEY: config.DB_SSL_KEY,
    DB_SSL_REJECT_UNAUTHORIZED: config.DB_SSL_REJECT_UNAUTHORIZED,
    DB_POOL_MAX: String(config.DB_POOL_MAX ?? DEFAULT_POOL_MAX),
    DB_POOL_IDLE_TIMEOUT_MS: String(config.DB_POOL_IDLE_TIMEOUT_MS ?? DEFAULT_IDLE_TIMEOUT_MS),
    DB_POOL_CONNECTION_TIMEOUT_MS: String(
      config.DB_POOL_CONNECTION_TIMEOUT_MS ?? DEFAULT_CONNECTION_TIMEOUT_MS,
    ),
  };
  const connectionString = source.DATABASE_URL;
  const host = source.DB_HOST;
  const database = source.DB_NAME;

  if (!connectionString && !(host && database)) return null;

  const base: PoolConfig = {
    max: positiveIntOr(source.DB_POOL_MAX, DEFAULT_POOL_MAX),
    idleTimeoutMillis: positiveIntOr(source.DB_POOL_IDLE_TIMEOUT_MS, DEFAULT_IDLE_TIMEOUT_MS),
    connectionTimeoutMillis: positiveIntOr(
      source.DB_POOL_CONNECTION_TIMEOUT_MS,
      DEFAULT_CONNECTION_TIMEOUT_MS,
    ),
    ssl: buildSslConfig(source),
  };

  if (connectionString) return { ...base, connectionString };

  return {
    ...base,
    host,
    port: positiveIntOr(source.DB_PORT, DEFAULT_PORT),
    database,
    user: source.DB_USER,
    password: source.DB_PASSWORD,
  };
}

/**
 * Parses the comma-separated `DATABASE_READ_REPLICAS` env var and returns one
 * PoolConfig per replica URL. Returns an empty array when the env var is unset.
 *
 * Each replica inherits the same SSL and pool-sizing settings as the primary so
 * operators only need to supply the connection strings.
 */
export function buildReplicaPoolConfigs(): PoolConfig[] {
  const raw = config.DATABASE_READ_REPLICAS;
  if (!raw || !raw.trim()) return [];

  const sslEnv: NodeJS.ProcessEnv = {
    NODE_ENV: config.NODE_ENV,
    DB_SSL: config.DB_SSL ?? 'false',
    DB_SSL_CA: config.DB_SSL_CA,
    DB_SSL_CERT: config.DB_SSL_CERT,
    DB_SSL_KEY: config.DB_SSL_KEY,
    DB_SSL_REJECT_UNAUTHORIZED: config.DB_SSL_REJECT_UNAUTHORIZED,
  };

  return raw
    .split(',')
    .map(url => url.trim())
    .filter(Boolean)
    .map(connectionString => ({
      connectionString,
      max: config.DB_POOL_MAX ?? DEFAULT_POOL_MAX,
      idleTimeoutMillis: config.DB_POOL_IDLE_TIMEOUT_MS ?? DEFAULT_IDLE_TIMEOUT_MS,
      connectionTimeoutMillis:
        config.DB_POOL_CONNECTION_TIMEOUT_MS ?? DEFAULT_CONNECTION_TIMEOUT_MS,
      ssl: buildSslConfig(sslEnv),
    }));
}

/**
 * Connection pool for the Core DB (PostgreSQL). Configured via `DATABASE_URL`, or
 * discrete `DB_HOST`/`DB_PORT`/`DB_NAME`/`DB_USER`/`DB_PASSWORD` env vars — see
 * `.env.example`. When neither is set (the default in dev/test), `PG_POOL` resolves
 * to `null` and `DatabaseService` reports itself as unconfigured rather than throwing,
 * so the app still boots without a local Postgres.
 *
 * Read replicas: set `DATABASE_READ_REPLICAS` to a comma-separated list of PostgreSQL
 * connection strings. `DatabaseService.queryRead()` distributes read-only queries
 * across the replica pools in round-robin order, falling back to the primary pool
 * when no replicas are configured or all replicas fail to connect.
 * All mutating queries always execute on the primary (`PG_POOL`).
 */
@Global()
@Module({
  providers: [
    {
      provide: PG_POOL,
      useFactory: async () => {
        const poolConfig = buildPoolConfig();
        if (!poolConfig) return null;

        const logger = new SanitizedLogger('DatabaseModule');
        const maxRetries = config.DB_RETRY_ATTEMPTS;
        const backoffBase = config.DB_RETRY_BACKOFF_MS;

        const pool = await retryWithExponentialBackoff(
          async () => {
            const newPool = new Pool(poolConfig);
            const client = await newPool.connect();
            client.release();
            return newPool;
          },
          maxRetries,
          backoffBase,
          logger,
        );

        logger.log('✓ Database connection established successfully');

        // A pool-level client can emit 'error' while idle (e.g. the server restarts) —
        // without this listener, that would crash the process via an unhandled 'error' event.
        pool.on('error', error => {
          logger.error('Unexpected error on an idle PostgreSQL client', error.stack);
        });
        return pool;
      },
    },
    {
      provide: PG_READ_POOLS,
      useFactory: async (): Promise<Pool[] | null> => {
        const replicaConfigs = buildReplicaPoolConfigs();
        if (replicaConfigs.length === 0) return null;

        const logger = new SanitizedLogger('DatabaseModule[replicas]');
        const pools: Pool[] = [];

        for (let i = 0; i < replicaConfigs.length; i++) {
          try {
            const pool = new Pool(replicaConfigs[i]);
            // Verify connectivity before accepting traffic
            const client = await pool.connect();
            client.release();
            pool.on('error', error => {
              logger.error(`Unexpected error on idle read-replica[${i}] client`, error.stack);
            });
            pools.push(pool);
            logger.log(`✓ Read-replica[${i}] connection established`);
          } catch (err) {
            logger.warn(
              `Read-replica[${i}] connection failed — skipping: ${(err as Error).message}`,
            );
          }
        }

        if (pools.length === 0) {
          logger.warn(
            'All configured read replicas failed to connect — reads will fall back to primary',
          );
          return null;
        }

        return pools;
      },
    },
    DatabaseService,
  ],
  exports: [PG_POOL, PG_READ_POOLS, DatabaseService],
})
export class DatabaseModule {}
