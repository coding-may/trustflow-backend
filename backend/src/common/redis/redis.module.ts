import { Module, Global, Logger } from '@nestjs/common';
import { Redis } from 'ioredis';
import { DistributedLockService } from './distributed-lock.service';
import { config } from '../../config/env.config';
import { REDIS_CLIENT } from './redis.constants';

export { REDIS_CLIENT } from './redis.constants';

/**
 * Build the app's ioredis client from `REDIS_URL`, or `null` when it is unset.
 *
 * ioredis is a Node `EventEmitter`, and an unhandled `'error'` event can crash
 * the process on some Node/ioredis versions; even where it doesn't, a
 * connection failure otherwise only surfaces as a rejected promise on the next
 * command. So an `'error'` listener is always attached and every failure is
 * logged via the NestJS `Logger` (#220).
 *
 * The connection is also attempted eagerly rather than waiting for the first
 * real command (`lazyConnect: true`), so a misconfigured `REDIS_URL` shows up
 * at startup. This never fails startup: `connect()`'s rejection is caught and
 * logged, ioredis keeps retrying per `retryStrategy`, and Redis-backed
 * features degrade until it recovers.
 */
export function createRedisClient(logger: Logger = new Logger('RedisModule')): Redis | null {
  const url = config.REDIS_URL;
  if (!url) {
    logger.warn(
      'REDIS_URL not set — Redis-backed features (rate limiting, outbox relay, caches) are disabled',
    );
    return null;
  }

  const client = new Redis(url, {
    maxRetriesPerRequest: 3,
    retryStrategy: times => Math.min(times * 100, 3000),
    lazyConnect: true,
  });

  client.on('error', err => logger.error(`Redis client error: ${err.message}`, err.stack));
  client.on('connect', () => logger.log('Redis connected'));
  client.on('reconnecting', () => logger.warn('Redis reconnecting…'));

  client
    .connect()
    .catch((err: Error) =>
      logger.error(
        `Initial Redis connection failed (will keep retrying per retryStrategy): ${err.message}`,
      ),
    );

  return client;
}

@Global()
@Module({
  providers: [
    {
      provide: REDIS_CLIENT,
      useFactory: (): Redis | null => createRedisClient(),
    },
    DistributedLockService,
  ],
  exports: [REDIS_CLIENT, DistributedLockService],
})
export class RedisModule {}
