import { Test, TestingModule } from '@nestjs/testing';
import { MigrationStateStore } from './migration-state.store';
import { MigrationRun, MigrationStatus } from './migration.types';
import { REDIS_CLIENT } from '../common/redis/redis.module';
import { MetricsService } from '../monitoring/metrics.service';
import { setTestEnv, resetEnvConfig } from '../config/env.config';

/**
 * Tests for TTL and pruning behavior added in #699.
 * Verifies that migration run records are expired after reaching terminal states
 * and that old runs are pruned to prevent unbounded growth.
 */
describe('MigrationStateStore TTL and Pruning (#699)', () => {
  let store: MigrationStateStore;
  let mockRedis: any;

  const createMockRun = (
    runId: string,
    migrationName: string,
    status: MigrationStatus,
  ): MigrationRun => ({
    runId,
    migrationName,
    targetTable: 'test_table',
    status,
    progress: {
      totalRows: 0,
      processedRows: 0,
      failedRows: 0,
      batchSize: 100,
    },
    stepHistory: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });

  beforeEach(async () => {
    setTestEnv({
      NODE_ENV: 'test',
      MIGRATION_RUN_TTL_SECONDS: '2592000', // 30 days
      MIGRATION_MAX_RUNS_PER_NAME: '50',
    });

    mockRedis = {
      multi: jest.fn().mockReturnThis(),
      set: jest.fn().mockReturnThis(),
      sadd: jest.fn().mockReturnThis(),
      expire: jest.fn().mockReturnThis(),
      exec: jest.fn().mockResolvedValue([[null, 'OK'], [null, 1], [null, 1]]),
      get: jest.fn().mockResolvedValue(null),
      smembers: jest.fn().mockResolvedValue([]),
      mget: jest.fn().mockResolvedValue([]),
      srem: jest.fn().mockResolvedValue(1),
      del: jest.fn().mockResolvedValue(1),
      pipeline: jest.fn().mockReturnThis(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MigrationStateStore,
        { provide: REDIS_CLIENT, useValue: mockRedis },
        {
          provide: MetricsService,
          useValue: { increment: jest.fn() },
        },
      ],
    }).compile();

    store = module.get<MigrationStateStore>(MigrationStateStore);
  });

  afterEach(() => {
    resetEnvConfig();
  });

  describe('TTL for terminal states', () => {
    it('should set TTL when saving a COMPLETED migration run', async () => {
      const run = createMockRun('run-1', 'test-migration', MigrationStatus.COMPLETED);

      await store.save(run);

      expect(mockRedis.expire).toHaveBeenCalledWith('migration:run:run-1', 2592000);
    });

    it('should set TTL when saving a FAILED migration run', async () => {
      const run = createMockRun('run-2', 'test-migration', MigrationStatus.FAILED);

      await store.save(run);

      expect(mockRedis.expire).toHaveBeenCalledWith('migration:run:run-2', 2592000);
    });

    it('should set TTL when saving a ROLLED_BACK migration run', async () => {
      const run = createMockRun('run-3', 'test-migration', MigrationStatus.ROLLED_BACK);

      await store.save(run);

      expect(mockRedis.expire).toHaveBeenCalledWith('migration:run:run-3', 2592000);
    });

    it('should NOT set TTL for PENDING state', async () => {
      const run = createMockRun('run-4', 'test-migration', MigrationStatus.PENDING);
      mockRedis.expire.mockClear();

      await store.save(run);

      expect(mockRedis.expire).not.toHaveBeenCalled();
    });

    it('should NOT set TTL for EXPANDING state', async () => {
      const run = createMockRun('run-5', 'test-migration', MigrationStatus.EXPANDING);
      mockRedis.expire.mockClear();

      await store.save(run);

      expect(mockRedis.expire).not.toHaveBeenCalled();
    });

    it('should NOT set TTL for BACKFILLING state', async () => {
      const run = createMockRun('run-6', 'test-migration', MigrationStatus.BACKFILLING);
      mockRedis.expire.mockClear();

      await store.save(run);

      expect(mockRedis.expire).not.toHaveBeenCalled();
    });

    it('should NOT set TTL for CONTRACTING state', async () => {
      const run = createMockRun('run-7', 'test-migration', MigrationStatus.CONTRACTING);
      mockRedis.expire.mockClear();

      await store.save(run);

      expect(mockRedis.expire).not.toHaveBeenCalled();
    });

    it('should NOT set TTL for ROLLING_BACK state', async () => {
      const run = createMockRun('run-8', 'test-migration', MigrationStatus.ROLLING_BACK);
      mockRedis.expire.mockClear();

      await store.save(run);

      expect(mockRedis.expire).not.toHaveBeenCalled();
    });
  });

  describe('findAll with stale index cleanup', () => {
    it('should remove stale IDs from index when keys have expired', async () => {
      const staleId = 'run-expired';
      const validId = 'run-valid';
      const validRun = createMockRun(validId, 'test-migration', MigrationStatus.COMPLETED);

      mockRedis.smembers.mockResolvedValue([staleId, validId]);
      mockRedis.mget.mockResolvedValue([null, JSON.stringify(validRun)]);

      const runs = await store.findAll();

      expect(runs).toHaveLength(1);
      expect(runs[0].runId).toBe(validId);
      expect(mockRedis.srem).toHaveBeenCalledWith('migration:runs:index', staleId);
    });

    it('should handle empty index gracefully', async () => {
      mockRedis.smembers.mockResolvedValue([]);

      const runs = await store.findAll();

      expect(runs).toEqual([]);
      expect(mockRedis.mget).not.toHaveBeenCalled();
    });

    it('should not call srem when no stale IDs found', async () => {
      const validId = 'run-valid';
      const validRun = createMockRun(validId, 'test-migration', MigrationStatus.COMPLETED);

      mockRedis.smembers.mockResolvedValue([validId]);
      mockRedis.mget.mockResolvedValue([JSON.stringify(validRun)]);
      mockRedis.srem.mockClear();

      await store.findAll();

      expect(mockRedis.srem).not.toHaveBeenCalled();
    });
  });

  describe('findById with expired keys', () => {
    it('should return undefined when key has expired', async () => {
      mockRedis.get.mockResolvedValue(null);

      const result = await store.findById('run-expired');

      expect(result).toBeUndefined();
    });

    it('should return run when key exists', async () => {
      const run = createMockRun('run-exists', 'test-migration', MigrationStatus.COMPLETED);
      mockRedis.get.mockResolvedValue(JSON.stringify(run));

      const result = await store.findById('run-exists');

      expect(result).toBeDefined();
      expect(result?.runId).toBe('run-exists');
    });
  });

  describe('pruning old runs', () => {
    it('should prune runs beyond MIGRATION_MAX_RUNS_PER_NAME', async () => {
      // Create 60 completed runs for the same migration (limit is 50)
      const runs: MigrationRun[] = [];
      for (let i = 0; i < 60; i++) {
        runs.push(
          createMockRun(`run-${i}`, 'test-migration', MigrationStatus.COMPLETED),
        );
      }

      // Mock findAll to return all 60 runs
      mockRedis.smembers.mockResolvedValue(runs.map(r => r.runId));
      mockRedis.mget.mockResolvedValue(runs.map(r => JSON.stringify(r)));

      // Mock pipeline for pruning
      const pipelineMock = {
        del: jest.fn().mockReturnThis(),
        srem: jest.fn().mockReturnThis(),
        exec: jest.fn().mockResolvedValue([]),
      };
      mockRedis.pipeline.mockReturnValue(pipelineMock);

      const run = createMockRun('run-new', 'test-migration', MigrationStatus.COMPLETED);
      await store.save(run);

      // Should prune 10 oldest runs (keeping 50)
      expect(pipelineMock.del).toHaveBeenCalled();
      expect(pipelineMock.srem).toHaveBeenCalled();
      expect(pipelineMock.exec).toHaveBeenCalled();
    });

    it('should not prune when runs are below limit', async () => {
      const runs: MigrationRun[] = [];
      for (let i = 0; i < 30; i++) {
        runs.push(
          createMockRun(`run-${i}`, 'test-migration', MigrationStatus.COMPLETED),
        );
      }

      mockRedis.smembers.mockResolvedValue(runs.map(r => r.runId));
      mockRedis.mget.mockResolvedValue(runs.map(r => JSON.stringify(r)));

      const pipelineMock = {
        del: jest.fn().mockReturnThis(),
        srem: jest.fn().mockReturnThis(),
        exec: jest.fn().mockResolvedValue([]),
      };
      mockRedis.pipeline.mockReturnValue(pipelineMock);

      const run = createMockRun('run-new', 'test-migration', MigrationStatus.COMPLETED);
      await store.save(run);

      // Should not call pipeline.exec since no pruning needed
      expect(pipelineMock.exec).not.toHaveBeenCalled();
    });

    it('should only prune terminal state runs', async () => {
      const runs: MigrationRun[] = [
        ...Array.from({ length: 30 }, (_, i) =>
          createMockRun(`run-completed-${i}`, 'test-migration', MigrationStatus.COMPLETED),
        ),
        ...Array.from({ length: 30 }, (_, i) =>
          createMockRun(`run-pending-${i}`, 'test-migration', MigrationStatus.PENDING),
        ),
      ];

      mockRedis.smembers.mockResolvedValue(runs.map(r => r.runId));
      mockRedis.mget.mockResolvedValue(runs.map(r => JSON.stringify(r)));

      const pipelineMock = {
        del: jest.fn().mockReturnThis(),
        srem: jest.fn().mockReturnThis(),
        exec: jest.fn().mockResolvedValue([]),
      };
      mockRedis.pipeline.mockReturnValue(pipelineMock);

      const run = createMockRun('run-new', 'test-migration', MigrationStatus.COMPLETED);
      await store.save(run);

      // Should not prune since only 31 terminal runs (below 50 limit)
      expect(pipelineMock.exec).not.toHaveBeenCalled();
    });

    it('should handle pruning errors gracefully', async () => {
      const runs: MigrationRun[] = [];
      for (let i = 0; i < 60; i++) {
        runs.push(
          createMockRun(`run-${i}`, 'test-migration', MigrationStatus.COMPLETED),
        );
      }

      mockRedis.smembers.mockResolvedValue(runs.map(r => r.runId));
      mockRedis.mget.mockResolvedValue(runs.map(r => JSON.stringify(r)));

      const pipelineMock = {
        del: jest.fn().mockReturnThis(),
        srem: jest.fn().mockReturnThis(),
        exec: jest.fn().mockRejectedValue(new Error('Pipeline failed')),
      };
      mockRedis.pipeline.mockReturnValue(pipelineMock);

      const run = createMockRun('run-new', 'test-migration', MigrationStatus.COMPLETED);

      // Should not throw, just log warning
      await expect(store.save(run)).resolves.not.toThrow();
    });
  });

  describe('fallback behavior (no Redis)', () => {
    beforeEach(async () => {
      const module: TestingModule = await Test.createTestingModule({
        providers: [
          MigrationStateStore,
          { provide: REDIS_CLIENT, useValue: null },
          {
            provide: MetricsService,
            useValue: { increment: jest.fn() },
          },
        ],
      }).compile();

      store = module.get<MigrationStateStore>(MigrationStateStore);
    });

    it('should use in-memory store when Redis is unavailable', async () => {
      const run = createMockRun('run-memory', 'test-migration', MigrationStatus.COMPLETED);

      await store.save(run);
      const retrieved = await store.findById('run-memory');

      expect(retrieved).toBeDefined();
      expect(retrieved?.runId).toBe('run-memory');
    });

    it('should not throw errors when pruning without Redis', async () => {
      const run = createMockRun('run-memory-2', 'test-migration', MigrationStatus.COMPLETED);

      await expect(store.save(run)).resolves.not.toThrow();
    });
  });
});
