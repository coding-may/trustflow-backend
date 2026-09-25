import { Test } from '@nestjs/testing';
import { validateEnv } from '../config/env.config';
import { DatabaseModule } from './database/database.module';
import { DatabaseService } from './database/database.service';
import { RedisModule } from './redis/redis.module';
import { DistributedLockService } from './redis/distributed-lock.service';

// #429: PG_POOL and REDIS_CLIENT used to be declared in the same file that
// imports the service consuming them, creating an import cycle that left the
// token undefined when Nest resolved it. Building the real module graph here
// (rather than constructing the services with `new`, which happens to dodge
// the cycle) is what actually catches that class of bug.
validateEnv();

describe('DatabaseModule / RedisModule DI graph (#429)', () => {
  const originalDatabaseUrl = process.env.DATABASE_URL;
  const originalDbHost = process.env.DB_HOST;
  const originalRedisUrl = process.env.REDIS_URL;

  beforeAll(() => {
    delete process.env.DATABASE_URL;
    delete process.env.DB_HOST;
    delete process.env.REDIS_URL;
  });

  afterAll(() => {
    if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalDatabaseUrl;
    if (originalDbHost === undefined) delete process.env.DB_HOST;
    else process.env.DB_HOST = originalDbHost;
    if (originalRedisUrl === undefined) delete process.env.REDIS_URL;
    else process.env.REDIS_URL = originalRedisUrl;
  });

  it('resolves DatabaseService from DatabaseModule with an unconfigured (null) pool', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [DatabaseModule],
    }).compile();

    const service = moduleRef.get(DatabaseService);
    expect(service).toBeInstanceOf(DatabaseService);
    expect(service.isConfigured).toBe(false);

    await moduleRef.close();
  });

  it('resolves DistributedLockService from RedisModule with an unconfigured (null) client', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [RedisModule],
    }).compile();

    const service = moduleRef.get(DistributedLockService);
    expect(service).toBeInstanceOf(DistributedLockService);

    // With no Redis client, tryAcquire fails open rather than throwing on an
    // undefined injected dependency.
    await expect(service.tryAcquire('lock:test', 1000)).resolves.toEqual(expect.any(String));

    await moduleRef.close();
  });
});
