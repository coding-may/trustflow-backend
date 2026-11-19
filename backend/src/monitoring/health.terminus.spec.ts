import { Test, TestingModule } from '@nestjs/testing';
import { HealthService } from './health.service';
import { HealthCheckService } from '@nestjs/terminus';
import { DatabaseService } from '../common/database/database.service';
import { REDIS_CLIENT } from '../common/redis/redis.module';
import { validateEnv } from '../config/env.config';

// checkSorobanRpcIndicator() reads config.STELLAR_HORIZON_URL, which requires validateEnv()
// to have run first — normally done once in main.ts (see health.service.spec.ts).
validateEnv();

describe('HealthService with Terminus', () => {
  let service: HealthService;
  let mockHealthCheckService: Partial<HealthCheckService>;
  let mockDatabase: Partial<DatabaseService>;
  let mockRedis: any;
  const originalFetch = global.fetch;
  const originalMemoryUsage = process.memoryUsage;

  afterEach(() => {
    global.fetch = originalFetch;
    process.memoryUsage = originalMemoryUsage;
  });

  beforeEach(async () => {
    // checkStellar()/checkSorobanRpcIndicator() hit the network otherwise — pin it healthy so
    // this suite isn't flaky on outbound connectivity (see health.service.spec.ts).
    global.fetch = jest.fn().mockResolvedValue({ ok: true }) as any;
    // checkMemory() reads real process heap usage, which this suite running alongside many
    // other test files shouldn't depend on — pin it well under the 500MB threshold (see
    // health.service.spec.ts).
    process.memoryUsage = jest.fn().mockReturnValue({
      heapUsed: 50 * 1024 * 1024,
      heapTotal: 100 * 1024 * 1024,
      rss: 100 * 1024 * 1024,
      external: 0,
      arrayBuffers: 0,
    }) as any;

    mockHealthCheckService = {
      check: jest.fn().mockResolvedValue({
        status: 'ok',
        info: {},
        error: {},
        details: {},
      }),
    };

    mockDatabase = {
      isConfigured: true,
      ping: jest.fn().mockResolvedValue(true),
    };

    mockRedis = {
      ping: jest.fn().mockResolvedValue('PONG'),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        HealthService,
        { provide: HealthCheckService, useValue: mockHealthCheckService },
        { provide: DatabaseService, useValue: mockDatabase },
        { provide: REDIS_CLIENT, useValue: mockRedis },
      ],
    }).compile();

    service = module.get<HealthService>(HealthService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('readiness', () => {
    it('should include detailed health check results', async () => {
      const result = await service.readiness();
      expect(result).toHaveProperty('status');
      expect(result).toHaveProperty('checks');
      expect(result).toHaveProperty('details');
    });

    it('should return ok status when all dependencies are healthy', async () => {
      const result = await service.readiness();
      expect(result.status).toBe('ok');
    });

    it('should include postgres health indicator', async () => {
      const result = await service.readiness();
      expect(mockHealthCheckService.check).toHaveBeenCalled();
    });
  });

  describe('check', () => {
    it('should include detailed Terminus health breakdown', async () => {
      const result = await service.check();
      expect(result).toHaveProperty('status');
      expect(result).toHaveProperty('checks');
      expect(result).toHaveProperty('details');
      expect(result).toHaveProperty('uptime');
    });
  });

  describe('health indicators', () => {
    it('should check Postgres indicator', async () => {
      await service['checkPostgresIndicator']();
      expect(mockDatabase.ping).toHaveBeenCalled();
    });

    it('should check Redis indicator', async () => {
      await service['checkRedisIndicator']();
      expect(mockRedis.ping).toHaveBeenCalled();
    });

    it('should check Soroban RPC indicator', async () => {
      const indicator = await service['checkSorobanRpcIndicator']();
      expect(indicator).toHaveProperty('soroban_rpc');
      expect(indicator.soroban_rpc).toHaveProperty('status');
    });
  });
});
