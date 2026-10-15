import { HealthService } from './health.service';
import { DatabaseService } from '../common/database/database.service';
import { DrainStateService } from '../common/shutdown/drain-state.service';
import type { Redis } from 'ioredis';

describe('HealthService', () => {
  const originalFetch = global.fetch;
  const originalMemoryUsage = process.memoryUsage;

  beforeEach(() => {
    mockLowMemoryUsage();
  });

  afterEach(() => {
    global.fetch = originalFetch;
    process.memoryUsage = originalMemoryUsage;
  });

  function mockFetchOk(ok = true) {
    global.fetch = jest.fn().mockResolvedValue({ ok }) as any;
  }

  /**
   * The `memory` check reads real process heap usage — deterministic on its own, but
   * this suite runs alongside hundreds of other test files in the same process, so the
   * actual heap size at this point isn't something these tests should depend on. Pin it
   * well under the 500MB threshold so `status` reflects only what each test is exercising.
   */
  function mockLowMemoryUsage() {
    process.memoryUsage = jest.fn().mockReturnValue({
      heapUsed: 50 * 1024 * 1024,
      heapTotal: 100 * 1024 * 1024,
      rss: 100 * 1024 * 1024,
      external: 0,
      arrayBuffers: 0,
    }) as any;
  }

  it('reports database: true when no DatabaseService is available (unit test wiring)', async () => {
    mockFetchOk(true);
    const service = new HealthService();

    const status = await service.check();

    expect(status.checks.database).toBe(true);
  });

  it('reports database: true when Postgres is not configured, without pinging', async () => {
    mockFetchOk(true);
    const database = { isConfigured: false, ping: jest.fn() } as unknown as DatabaseService;
    const service = new HealthService(database);

    const status = await service.check();

    expect(status.checks.database).toBe(true);
    expect(database.ping).not.toHaveBeenCalled();
  });

  it('reports database: true when Postgres is configured and ping succeeds', async () => {
    mockFetchOk(true);
    const database = {
      isConfigured: true,
      ping: jest.fn().mockResolvedValue(true),
    } as unknown as DatabaseService;
    const service = new HealthService(database);

    const status = await service.check();

    expect(status.checks.database).toBe(true);
    expect(database.ping).toHaveBeenCalled();
  });

  it('reports database: false and status degraded when Postgres is configured but unreachable', async () => {
    mockFetchOk(true);
    const database = {
      isConfigured: true,
      ping: jest.fn().mockResolvedValue(false),
    } as unknown as DatabaseService;
    const service = new HealthService(database);

    const status = await service.check();

    expect(status.checks.database).toBe(false);
    expect(status.status).toBe('degraded');
  });

  it('reports overall status ok when every check passes', async () => {
    mockFetchOk(true);
    const database = {
      isConfigured: true,
      ping: jest.fn().mockResolvedValue(true),
    } as unknown as DatabaseService;
    const service = new HealthService(database);

    const status = await service.check();

    expect(status.status).toBe('ok');
    expect(status.checks).toEqual({ api: true, stellar: true, database: true, redis: true, memory: true });
  });

  describe('liveness()', () => {
    it('resolves to { status: "up" }', async () => {
      mockFetchOk(true);
      const service = new HealthService();

      const result = await service.liveness();

      expect(result).toEqual({ status: 'up' });
    });
  });

  describe('readiness()', () => {
    it('short-circuits to { status: "down", checks: { draining: false } } when DrainStateService.isDraining() is true', async () => {
      mockFetchOk(true);
      const database = {
        isConfigured: true,
        ping: jest.fn().mockResolvedValue(true),
      } as unknown as DatabaseService;
      const drainState = {
        isDraining: jest.fn().mockReturnValue(true),
      } as unknown as DrainStateService;
      const service = new HealthService(database, null, drainState);

      const result = await service.readiness();

      expect(result).toEqual({ status: 'down', checks: { draining: false } });
      expect(database.ping).not.toHaveBeenCalled();
    });

    it('falls through to normal aggregate check when DrainStateService.isDraining() is false', async () => {
      mockFetchOk(true);
      const database = {
        isConfigured: true,
        ping: jest.fn().mockResolvedValue(true),
      } as unknown as DatabaseService;
      const drainState = {
        isDraining: jest.fn().mockReturnValue(false),
      } as unknown as DrainStateService;
      const service = new HealthService(database, null, drainState);

      const result = await service.readiness();

      expect(result.status).toBe('ok');
      expect(result.checks).toEqual({ api: true, stellar: true, database: true, redis: true, memory: true });
      expect(database.ping).toHaveBeenCalled();
    });

    it('falls through to normal aggregate check when no DrainStateService is available', async () => {
      mockFetchOk(true);
      const database = {
        isConfigured: true,
        ping: jest.fn().mockResolvedValue(true),
      } as unknown as DatabaseService;
      const service = new HealthService(database);

      const result = await service.readiness();

      expect(result.status).toBe('ok');
      expect(result.checks).toEqual({ api: true, stellar: true, database: true, redis: true, memory: true });
    });
  });

  describe('checkRedis()', () => {
    it('reports redis: true when no REDIS_CLIENT is injected', async () => {
      mockFetchOk(true);
      const service = new HealthService();

      const status = await service.check();

      expect(status.checks.redis).toBe(true);
    });

    it('reports redis: true when ping() resolves "PONG"', async () => {
      mockFetchOk(true);
      const redis = {
        ping: jest.fn().mockResolvedValue('PONG'),
      } as unknown as Redis;
      const service = new HealthService(undefined, redis);

      const status = await service.check();

      expect(status.checks.redis).toBe(true);
      expect(redis.ping).toHaveBeenCalled();
    });

    it('reports redis: false when ping() resolves anything other than "PONG"', async () => {
      mockFetchOk(true);
      const redis = {
        ping: jest.fn().mockResolvedValue('INVALID'),
      } as unknown as Redis;
      const service = new HealthService(undefined, redis);

      const status = await service.check();

      expect(status.checks.redis).toBe(false);
      expect(status.status).toBe('degraded');
    });

    it('reports redis: false when ping() rejects', async () => {
      mockFetchOk(true);
      const redis = {
        ping: jest.fn().mockRejectedValue(new Error('Connection refused')),
      } as unknown as Redis;
      const service = new HealthService(undefined, redis);

      const status = await service.check();

      expect(status.checks.redis).toBe(false);
      expect(status.status).toBe('degraded');
    });
  });

  describe('checkStellar()', () => {
    it('reports stellar: false when fetch resolves { ok: false }', async () => {
      mockFetchOk(false);
      const service = new HealthService();

      const status = await service.check();

      expect(status.checks.stellar).toBe(false);
      expect(status.status).toBe('degraded');
    });

    it('reports stellar: false when fetch rejects', async () => {
      global.fetch = jest.fn().mockRejectedValue(new Error('Network error')) as any;
      const service = new HealthService();

      const status = await service.check();

      expect(status.checks.stellar).toBe(false);
      expect(status.status).toBe('degraded');
    });

    it('reports stellar: false when fetch times out', async () => {
      global.fetch = jest.fn().mockImplementation(() => new Promise(() => {})) as any;
      const service = new HealthService();

      const status = await service.check();

      expect(status.checks.stellar).toBe(false);
      expect(status.status).toBe('degraded');
    });
  });
});
