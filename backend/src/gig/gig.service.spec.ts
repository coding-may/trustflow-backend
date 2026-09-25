import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { GigService, GIG_PERSISTENCE_FALLBACK_METRIC } from './gig.service';
import { GigStatus } from './gig.entity';
import { REDIS_CLIENT } from '../common/redis/redis.module';
import { MetricsService } from '../monitoring/metrics.service';

/** Mirrors ioredis: MULTI/EXEC resolves an array of [error, result] tuples per queued command. */
function makeInMemoryRedis() {
  const store = new Map<string, string>();
  const sets = new Map<string, Set<string>>();
  const zsets = new Map<string, Map<string, number>>();
  /** When set, the next MULTI's exec() returns this instead of the computed op results. */
  let nextExecOverride: (() => Promise<Array<[Error | null, unknown]> | null>) | null = null;

  const client = {
    mockNextExecResult(fn: () => Promise<Array<[Error | null, unknown]> | null>) {
      nextExecOverride = fn;
    },
    get: jest.fn(async (key: string) => store.get(key) ?? null),
    mget: jest.fn(async (...keys: string[]) => keys.map(k => store.get(k) ?? null)),
    set: jest.fn(async (key: string, value: string, ..._opts: unknown[]) => {
      store.set(key, value);
      return 'OK';
    }),
    del: jest.fn(async (...keys: string[]) => {
      let count = 0;
      for (const key of keys) {
        if (store.delete(key)) count += 1;
        sets.delete(key);
        zsets.delete(key);
      }
      return count;
    }),
    sadd: jest.fn(async (key: string, member: string) => {
      if (!sets.has(key)) sets.set(key, new Set());
      sets.get(key)!.add(member);
      return 1;
    }),
    smembers: jest.fn(async (key: string) => [...(sets.get(key) ?? [])]),
    zrange: jest.fn(async (key: string) => {
      const z = zsets.get(key) ?? new Map();
      return [...z.entries()].sort((a, b) => a[1] - b[1]).map(([member]) => member);
    }),
    zrangebyscore: jest.fn(async (key: string, min: number, max: number) => {
      const z = zsets.get(key) ?? new Map();
      return [...z.entries()]
        .filter(([, score]) => score >= min && score <= max)
        .sort((a, b) => a[1] - b[1])
        .map(([member]) => member);
    }),
    multi: jest.fn(() => {
      const ops: Array<() => [Error | null, unknown]> = [];
      const chain = {
        set: (key: string, value: string) => {
          ops.push(() => {
            store.set(key, value);
            return [null, 'OK'];
          });
          return chain;
        },
        zadd: (key: string, score: number, member: string) => {
          ops.push(() => {
            if (!zsets.has(key)) zsets.set(key, new Map());
            zsets.get(key)!.set(member, score);
            return [null, 1];
          });
          return chain;
        },
        zrem: (key: string, member: string) => {
          ops.push(() => {
            zsets.get(key)?.delete(member);
            return [null, 1];
          });
          return chain;
        },
        sadd: (key: string, member: string) => {
          ops.push(() => {
            if (!sets.has(key)) sets.set(key, new Set());
            sets.get(key)!.add(member);
            return [null, 1];
          });
          return chain;
        },
        exec: async () => {
          if (nextExecOverride) {
            const fn = nextExecOverride;
            nextExecOverride = null;
            return fn();
          }
          return ops.map(op => op());
        },
      };
      return chain;
    }),
  };

  return client;
}

describe('GigService', () => {
  let service: GigService;
  let metrics: jest.Mocked<Pick<MetricsService, 'increment'>>;

  const validDto = {
    creator: 'GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
    title: 'Build a Soroban escrow audit report',
    budgetXLM: '250',
  };

  async function buildService(redis: unknown): Promise<GigService> {
    metrics = { increment: jest.fn() };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        GigService,
        { provide: REDIS_CLIENT, useValue: redis },
        { provide: MetricsService, useValue: metrics },
      ],
    }).compile();

    return module.get<GigService>(GigService);
  }

  describe.each([
    ['with Redis', () => makeInMemoryRedis()],
    ['without Redis (fallback to memory)', () => null],
  ])('%s', (_label, makeRedis) => {
    beforeEach(async () => {
      service = await buildService(makeRedis());
    });

    it('should be defined', () => {
      expect(service).toBeDefined();
    });

    describe('create', () => {
      it('creates an open gig with a default 72h response deadline', async () => {
        const before = Date.now();
        const gig = await service.create(validDto);

        expect(gig.id).toBeDefined();
        expect(gig.creator).toBe(validDto.creator);
        expect(gig.title).toBe(validDto.title);
        expect(gig.budgetXLM).toBe(validDto.budgetXLM);
        expect(gig.status).toBe(GigStatus.OPEN);

        const expectedRespondBy = before + 72 * 60 * 60 * 1000;
        expect(new Date(gig.respondBy).getTime()).toBeGreaterThanOrEqual(expectedRespondBy - 1000);
      });

      it('honors a custom responseWindowHours', async () => {
        const gig = await service.create({ ...validDto, responseWindowHours: 1 });
        const createdAt = new Date(gig.createdAt).getTime();
        const respondBy = new Date(gig.respondBy).getTime();
        expect(respondBy - createdAt).toBe(60 * 60 * 1000);
      });
    });

    describe('findById', () => {
      it('throws NotFoundException for an unknown id', async () => {
        await expect(service.findById('missing')).rejects.toThrow(NotFoundException);
      });

      it('returns the gig when it exists', async () => {
        const created = await service.create(validDto);
        expect(await service.findById(created.id)).toEqual(created);
      });
    });

    describe('findByCreator', () => {
      it('returns only gigs posted by the given creator', async () => {
        const gig = await service.create(validDto);
        await service.create({
          ...validDto,
          creator: 'GYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYY',
        });

        const result = await service.findByCreator(validDto.creator);
        expect(result.data).toEqual([gig]);
        expect(result.total).toBe(1);
      });

      it('returns paginated results', async () => {
        for (let i = 0; i < 5; i++) {
          await service.create({ ...validDto, title: `Gig ${i}` });
        }

        const page1 = await service.findByCreator(validDto.creator, { offset: 0, limit: 2 });
        const page2 = await service.findByCreator(validDto.creator, { offset: 2, limit: 2 });

        expect(page1.data).toHaveLength(2);
        expect(page2.data).toHaveLength(2);
        expect(page1.total).toBe(5);
        expect(page1.data[0].id).not.toBe(page2.data[0].id);
      });

      it('filters by status', async () => {
        const gig = await service.create(validDto);
        await service.accept(gig.id, 'GYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYY');
        await service.create({ ...validDto, title: 'Second gig' });

        const result = await service.findByCreator(validDto.creator, { status: GigStatus.OPEN });
        expect(result.data).toHaveLength(1);
        expect(result.data[0].status).toBe(GigStatus.OPEN);
      });

      it('filters by minBudgetXLM', async () => {
        await service.create({ ...validDto, budgetXLM: '50' });
        await service.create({ ...validDto, budgetXLM: '200', title: 'Expensive gig' });

        const result = await service.findByCreator(validDto.creator, { minBudgetXLM: '100' });
        expect(result.data).toHaveLength(1);
        expect(result.data[0].budgetXLM).toBe('200');
      });

      it('filters by maxBudgetXLM', async () => {
        await service.create({ ...validDto, budgetXLM: '50' });
        await service.create({ ...validDto, budgetXLM: '200', title: 'Expensive gig' });

        const result = await service.findByCreator(validDto.creator, { maxBudgetXLM: '100' });
        expect(result.data).toHaveLength(1);
        expect(result.data[0].budgetXLM).toBe('50');
      });

      it('filters by budget range', async () => {
        await service.create({ ...validDto, budgetXLM: '10' });
        await service.create({ ...validDto, budgetXLM: '50', title: 'Mid gig' });
        await service.create({ ...validDto, budgetXLM: '200', title: 'Expensive gig' });

        const result = await service.findByCreator(validDto.creator, {
          minBudgetXLM: '25',
          maxBudgetXLM: '100',
        });
        expect(result.data).toHaveLength(1);
        expect(result.data[0].budgetXLM).toBe('50');
      });
    });

    describe('findExpirable', () => {
      it('excludes gigs whose response deadline has not passed', async () => {
        await service.create(validDto);
        expect(await service.findExpirable()).toEqual([]);
      });

      it('includes only OPEN gigs whose response deadline has passed', async () => {
        const gig = await service.create({ ...validDto, responseWindowHours: 1 });
        const future = new Date(Date.now() + 2 * 60 * 60 * 1000);

        expect(await service.findExpirable(future)).toEqual([gig]);
      });

      it('excludes gigs that are no longer OPEN even if their deadline passed', async () => {
        const gig = await service.create({ ...validDto, responseWindowHours: 1 });
        await service.accept(gig.id, 'GYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYY');
        const future = new Date(Date.now() + 2 * 60 * 60 * 1000);

        expect(await service.findExpirable(future)).toEqual([]);
      });
    });

    describe('search', () => {
      it('defaults to open gigs, newest first, page 1 of 20', async () => {
        // Gigs created in the same millisecond would tie on createdAt — advance the clock
        // between creates so "newest first" has something meaningful to assert on.
        jest.useFakeTimers();
        jest.setSystemTime(new Date('2024-01-01T00:00:00.000Z'));
        const first = await service.create(validDto);

        jest.setSystemTime(new Date('2024-01-01T00:00:01.000Z'));
        const second = await service.create({ ...validDto, title: 'Second gig' });
        await service.accept(second.id, 'GYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYY');

        jest.setSystemTime(new Date('2024-01-01T00:00:02.000Z'));
        const third = await service.create({ ...validDto, title: 'Third gig' });
        jest.useRealTimers();

        const result = await service.search();

        expect(result).toEqual({
          items: [third, first],
          total: 2,
          page: 1,
          limit: 20,
        });
      });

      it('filters by an explicit status', async () => {
        const gig = await service.create(validDto);
        await service.accept(gig.id, 'GYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYY');

        const result = await service.search({ status: GigStatus.ACCEPTED });

        expect(result.items).toHaveLength(1);
        expect(result.items[0].id).toBe(gig.id);
      });

      it('paginates results', async () => {
        for (let i = 0; i < 5; i++) {
          await service.create({ ...validDto, title: `Gig ${i}` });
        }

        const page1 = await service.search({ page: 1, limit: 2 });
        const page2 = await service.search({ page: 2, limit: 2 });

        expect(page1.items).toHaveLength(2);
        expect(page2.items).toHaveLength(2);
        expect(page1.total).toBe(5);
        expect(page1.items[0].id).not.toBe(page2.items[0].id);
      });

      it('returns an empty page past the end of the results', async () => {
        await service.create(validDto);

        const result = await service.search({ page: 5, limit: 20 });

        expect(result.items).toEqual([]);
        expect(result.total).toBe(1);
      });

      it('filters by minBudgetXLM', async () => {
        await service.create({ ...validDto, budgetXLM: '50' });
        await service.create({ ...validDto, budgetXLM: '200', title: 'Expensive gig' });

        const result = await service.search({ minBudgetXLM: '100' });

        expect(result.items).toHaveLength(1);
        expect(result.items[0].budgetXLM).toBe('200');
      });

      it('filters by maxBudgetXLM', async () => {
        await service.create({ ...validDto, budgetXLM: '50' });
        await service.create({ ...validDto, budgetXLM: '200', title: 'Expensive gig' });

        const result = await service.search({ maxBudgetXLM: '100' });

        expect(result.items).toHaveLength(1);
        expect(result.items[0].budgetXLM).toBe('50');
      });

      it('filters by budget range', async () => {
        await service.create({ ...validDto, budgetXLM: '10' });
        await service.create({ ...validDto, budgetXLM: '50', title: 'Mid gig' });
        await service.create({ ...validDto, budgetXLM: '200', title: 'Expensive gig' });

        const result = await service.search({ minBudgetXLM: '25', maxBudgetXLM: '100' });

        expect(result.items).toHaveLength(1);
        expect(result.items[0].budgetXLM).toBe('50');
      });
    });

    describe('accept', () => {
      it('marks an open gig as accepted', async () => {
        const gig = await service.create(validDto);
        const responder = 'GYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYY';

        const accepted = await service.accept(gig.id, responder);

        expect(accepted.status).toBe(GigStatus.ACCEPTED);
        expect(accepted.acceptedBy).toBe(responder);
        expect(accepted.acceptedAt).toBeDefined();
      });

      it('throws when the gig is not open', async () => {
        const gig = await service.create(validDto);
        await service.accept(gig.id, 'GYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYY');

        await expect(
          service.accept(gig.id, 'GZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ'),
        ).rejects.toThrow(BadRequestException);
      });
    });

    describe('cancel', () => {
      it('marks an open gig as cancelled', async () => {
        const gig = await service.create(validDto);
        const cancelled = await service.cancel(gig.id);

        expect(cancelled.status).toBe(GigStatus.CANCELLED);
        expect(cancelled.cancelledAt).toBeDefined();
      });

      it('throws when the gig is not open', async () => {
        const gig = await service.create(validDto);
        await service.cancel(gig.id);

        await expect(service.cancel(gig.id)).rejects.toThrow(BadRequestException);
      });
    });

    describe('update', () => {
      it('applies title and budget changes', async () => {
        const gig = await service.create(validDto);

        const updated = await service.update(gig.id, { title: 'New title', budgetXLM: '999' });

        expect(updated.title).toBe('New title');
        expect(updated.budgetXLM).toBe('999');
      });

      it('throws when the gig is not open', async () => {
        const gig = await service.create(validDto);
        await service.cancel(gig.id);

        await expect(service.update(gig.id, { title: 'New title' })).rejects.toThrow(
          BadRequestException,
        );
      });

      // #432: responseWindowHours was validated and accepted by the controller/DTO but
      // silently dropped by the service, leaving `respondBy` (and the expiry sweep) unchanged.
      it('applies responseWindowHours to respondBy, and the sweep honors the new deadline', async () => {
        jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
        try {
          const gig = await service.create(validDto);
          const originalRespondBy = gig.respondBy;

          const updated = await service.update(gig.id, { responseWindowHours: 1 });

          expect(updated.respondBy).not.toBe(originalRespondBy);
          expect(new Date(updated.respondBy).getTime()).toBe(Date.now() + 60 * 60 * 1000);

          // Not yet due at +30 minutes.
          jest.advanceTimersByTime(30 * 60 * 1000);
          expect((await service.findExpirable()).map(g => g.id)).not.toContain(gig.id);

          // Past the new 1-hour deadline at +61 minutes total.
          jest.advanceTimersByTime(31 * 60 * 1000);
          expect((await service.findExpirable()).map(g => g.id)).toContain(gig.id);
        } finally {
          jest.useRealTimers();
        }
      });

      it('leaves respondBy unchanged when responseWindowHours is omitted', async () => {
        const gig = await service.create(validDto);

        const updated = await service.update(gig.id, { title: 'New title' });

        expect(updated.respondBy).toBe(gig.respondBy);
      });
    });

    describe('expire', () => {
      it('marks an open gig as expired', async () => {
        const gig = await service.create(validDto);
        const expired = await service.expire(gig.id);

        expect(expired?.status).toBe(GigStatus.EXPIRED);
        expect(expired?.expiredAt).toBeDefined();
      });

      it('is a no-op for a gig that is already resolved', async () => {
        const gig = await service.create(validDto);
        await service.accept(gig.id, 'GYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYY');

        expect(await service.expire(gig.id)).toBeUndefined();
        expect((await service.findById(gig.id)).status).toBe(GigStatus.ACCEPTED);
      });

      it('is a no-op for an unknown id', async () => {
        expect(await service.expire('missing')).toBeUndefined();
      });
    });
  });

  describe('search caching (Redis)', () => {
    it('serves a repeat query from cache instead of recomputing from findAll()', async () => {
      const redis = makeInMemoryRedis();
      service = await buildService(redis);
      const gig = await service.create(validDto);

      const first = await service.search();
      redis.mget.mockClear();
      const second = await service.search();

      expect(second).toEqual(first);
      expect(second.items[0].id).toBe(gig.id);
      // findAll() -> fetchMany() -> mget; a cache hit should skip it entirely.
      expect(redis.mget).not.toHaveBeenCalled();
    });

    it('caches the search result under GIG_SEARCH_CACHE_TTL_SECONDS', async () => {
      process.env.GIG_SEARCH_CACHE_TTL_SECONDS = '45';
      const redis = makeInMemoryRedis();
      service = await buildService(redis);

      await service.search();

      expect(redis.set).toHaveBeenCalledWith(
        expect.stringMatching(/^gigs:search:open:1:20:[0-9a-f]{16}$/),
        expect.any(String),
        'EX',
        45,
      );
      delete process.env.GIG_SEARCH_CACHE_TTL_SECONDS;
    });

    it('does not share a cache entry between an unfiltered search and a budget-filtered one (#430)', async () => {
      const redis = makeInMemoryRedis();
      service = await buildService(redis);
      await service.create({ ...validDto, budgetXLM: '10' });
      await service.create({ ...validDto, budgetXLM: '1000' });

      const filtered = await service.search({ minBudgetXLM: '500' });
      expect(filtered.total).toBe(1);
      expect(filtered.items[0].budgetXLM).toBe('1000');

      const unfiltered = await service.search({});
      expect(unfiltered.total).toBe(2);

      const maxFiltered = await service.search({ maxBudgetXLM: '50' });
      expect(maxFiltered.total).toBe(1);
      expect(maxFiltered.items[0].budgetXLM).toBe('10');
    });

    it('invalidates every cached budget-filter variant on mutation (#430)', async () => {
      const redis = makeInMemoryRedis();
      service = await buildService(redis);
      await service.search({});
      await service.search({ minBudgetXLM: '500' });
      await service.search({ maxBudgetXLM: '50' });

      await service.create({ ...validDto, budgetXLM: '1000' });
      redis.mget.mockClear();

      await service.search({});
      await service.search({ minBudgetXLM: '500' });
      await service.search({ maxBudgetXLM: '50' });

      // Each variant should be a fresh cache miss (findAll -> fetchMany -> mget) after invalidation.
      expect(redis.mget).toHaveBeenCalledTimes(3);
    });

    it('invalidates the cache when a gig is created, so a stale page is never served', async () => {
      const redis = makeInMemoryRedis();
      service = await buildService(redis);
      await service.search();

      await service.create({ ...validDto, title: 'New gig' });
      redis.mget.mockClear();
      const result = await service.search();

      expect(result.total).toBe(1);
      expect(redis.mget).toHaveBeenCalled();
    });

    it('invalidates the cache when a gig transitions status (accept)', async () => {
      const redis = makeInMemoryRedis();
      service = await buildService(redis);
      const gig = await service.create(validDto);
      await service.search();

      await service.accept(gig.id, 'GYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYY');
      const result = await service.search();

      expect(result.total).toBe(0);
    });
  });

  describe('Redis failure', () => {
    it('falls back to memory and records the fallback metric when Redis throws', async () => {
      const redis = makeInMemoryRedis();
      redis.get.mockRejectedValue(new Error('Redis down'));
      redis.multi.mockImplementation(() => {
        throw new Error('Redis down');
      });
      service = await buildService(redis);

      const gig = await service.create(validDto);

      expect(gig.status).toBe(GigStatus.OPEN);
      expect(metrics.increment).toHaveBeenCalledWith(GIG_PERSISTENCE_FALLBACK_METRIC, {
        operation: 'create',
      });
    });

    it('falls back to memory when a queued MULTI command fails without exec() itself rejecting', async () => {
      const redis = makeInMemoryRedis();
      redis.mockNextExecResult(async () => [
        [null, 'OK'],
        [new Error('WRONGTYPE'), null],
      ]);
      service = await buildService(redis);

      const gig = await service.create(validDto);

      expect(gig.status).toBe(GigStatus.OPEN);
      expect(metrics.increment).toHaveBeenCalledWith(GIG_PERSISTENCE_FALLBACK_METRIC, {
        operation: 'create',
      });
    });

    it('falls back to memory when exec() resolves null (e.g. an aborted WATCH)', async () => {
      const redis = makeInMemoryRedis();
      redis.mockNextExecResult(async () => null);
      service = await buildService(redis);

      const gig = await service.create(validDto);

      expect(gig.status).toBe(GigStatus.OPEN);
      expect(metrics.increment).toHaveBeenCalledWith(GIG_PERSISTENCE_FALLBACK_METRIC, {
        operation: 'create',
      });
    });
  });

  describe('onModuleInit', () => {
    const originalNodeEnv = process.env.NODE_ENV;

    afterEach(() => {
      process.env.NODE_ENV = originalNodeEnv;
    });

    it('throws in production when Redis is not configured', async () => {
      process.env.NODE_ENV = 'production';
      service = await buildService(null);

      expect(() => service.onModuleInit()).toThrow(/requires REDIS_URL/);
    });

    it('does not throw in production when Redis is configured', async () => {
      process.env.NODE_ENV = 'production';
      service = await buildService(makeInMemoryRedis());

      expect(() => service.onModuleInit()).not.toThrow();
    });

    it('does not throw outside production even without Redis', async () => {
      process.env.NODE_ENV = 'test';
      service = await buildService(null);

      expect(() => service.onModuleInit()).not.toThrow();
    });
  });
});
