import { Test, TestingModule } from '@nestjs/testing';
import { ConflictException, BadRequestException, NotFoundException } from '@nestjs/common';
import { MigrationRunnerService } from './migration-runner.service';
import { MigrationRegistryService, MIGRATION_DEFINITIONS } from './migration-registry.service';
import { MigrationStateStore } from './migration-state.store';
import {
  BackfillBatchResult,
  MigrationPhase,
  MigrationStatus,
  SchemaMigration,
} from './migration.types';

class FakeMigration extends SchemaMigration {
  readonly name = 'fake-migration';
  readonly targetTable = 'fake_table';
  readonly description = 'Fake migration for testing the runner';

  totalRows = 10;
  failBackfillOnBatch?: number;
  failExpand = false;
  failContract = false;
  failRollbackExpand = false;
  failRollbackContract = false;

  batchesServed = 0;
  expandCalls = 0;
  contractCalls = 0;
  rollbackExpandCalls = 0;
  rollbackContractCalls = 0;

  async expand(): Promise<void> {
    this.expandCalls++;
    if (this.failExpand) throw new Error('expand failed');
  }

  async countPending(): Promise<number> {
    return this.totalRows;
  }

  async backfillBatch(cursor: string | undefined, batchSize: number): Promise<BackfillBatchResult> {
    this.batchesServed++;
    if (this.failBackfillOnBatch === this.batchesServed) {
      throw new Error(`backfill failed on batch ${this.batchesServed}`);
    }

    const start = cursor ? Number(cursor) : 0;
    const processed = Math.min(batchSize, this.totalRows - start);
    const next = start + processed;
    return { processed, failed: 0, nextCursor: String(next), done: next >= this.totalRows };
  }

  async contract(): Promise<void> {
    this.contractCalls++;
    if (this.failContract) throw new Error('contract failed');
  }

  async rollbackExpand(): Promise<void> {
    this.rollbackExpandCalls++;
    if (this.failRollbackExpand) throw new Error('rollback expand failed');
  }

  async rollbackContract(): Promise<void> {
    this.rollbackContractCalls++;
    if (this.failRollbackContract) throw new Error('rollback contract failed');
  }
}

describe('MigrationRunnerService', () => {
  let runner: MigrationRunnerService;
  let fake: FakeMigration;

  beforeEach(async () => {
    fake = new FakeMigration();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MigrationRunnerService,
        MigrationRegistryService,
        MigrationStateStore,
        { provide: MIGRATION_DEFINITIONS, useValue: [fake] },
      ],
    }).compile();

    runner = module.get<MigrationRunnerService>(MigrationRunnerService);
  });

  it('completes the full expand -> backfill -> contract lifecycle and tracks progress', async () => {
    fake.totalRows = 10;
    const run = await runner.run(fake.name, { batchSize: 4 });

    expect(run.status).toBe(MigrationStatus.COMPLETED);
    expect(run.progress.totalRows).toBe(10);
    expect(run.progress.processedRows).toBe(10);
    expect(run.progress.failedRows).toBe(0);
    expect(fake.expandCalls).toBe(1);
    expect(fake.contractCalls).toBe(1);
    expect(fake.batchesServed).toBe(3); // 4 + 4 + 2

    const phases = run.stepHistory.map(s => s.phase);
    expect(phases).toEqual([
      MigrationPhase.EXPAND,
      MigrationPhase.BACKFILL,
      MigrationPhase.CONTRACT,
    ]);
    expect(run.stepHistory.every(s => s.completedAt && !s.failedAt)).toBe(true);
  });

  it('handles a migration with zero pending rows without looping', async () => {
    fake.totalRows = 0;
    const run = await runner.run(fake.name, { batchSize: 4 });

    expect(run.status).toBe(MigrationStatus.COMPLETED);
    expect(run.progress.totalRows).toBe(0);
    expect(fake.batchesServed).toBe(0);
  });

  it('rolls back via compensating actions when backfill fails', async () => {
    fake.totalRows = 10;
    fake.failBackfillOnBatch = 2;

    await expect(runner.run(fake.name, { batchSize: 4 })).rejects.toThrow(
      'backfill failed on batch 2',
    );

    expect(fake.rollbackExpandCalls).toBe(1);
    expect(fake.rollbackContractCalls).toBe(0); // contract phase was never reached
    expect(fake.contractCalls).toBe(0);

    const [run] = await runner.findAll();
    expect(run.status).toBe(MigrationStatus.ROLLED_BACK);
    expect(run.rollbackReason).toBe('backfill failed on batch 2');
    const backfillRecord = run.stepHistory.find(s => s.phase === MigrationPhase.BACKFILL);
    expect(backfillRecord?.failedAt).toBeDefined();
  });

  it('rolls back both contract and expand when the contract phase fails', async () => {
    fake.totalRows = 4;
    fake.failContract = true;

    await expect(runner.run(fake.name, { batchSize: 10 })).rejects.toThrow('contract failed');

    expect(fake.rollbackContractCalls).toBe(1);
    expect(fake.rollbackExpandCalls).toBe(1);

    const [run] = await runner.findAll();
    expect(run.status).toBe(MigrationStatus.ROLLED_BACK);
  });

  it('marks the run FAILED when the rollback itself throws', async () => {
    fake.totalRows = 4;
    fake.failContract = true;
    fake.failRollbackContract = true;

    await expect(runner.run(fake.name, { batchSize: 10 })).rejects.toThrow(
      'rollback contract failed',
    );

    const [run] = await runner.findAll();
    expect(run.status).toBe(MigrationStatus.FAILED);
  });

  it('rejects a second concurrent run of the same migration', async () => {
    fake.totalRows = 2;
    const first = runner.run(fake.name, { batchSize: 1, batchDelayMs: 20 });

    await expect(runner.run(fake.name)).rejects.toThrow(ConflictException);

    await first;
  });

  it('allows a manual rollback of a completed run without flagging the phase as failed', async () => {
    fake.totalRows = 2;
    const run = await runner.run(fake.name, { batchSize: 10 });

    const rolledBack = await runner.rollback(run.runId);

    expect(rolledBack.status).toBe(MigrationStatus.ROLLED_BACK);
    expect(fake.rollbackContractCalls).toBe(1);
    expect(fake.rollbackExpandCalls).toBe(1);
    const contractRecord = rolledBack.stepHistory.find(s => s.phase === MigrationPhase.CONTRACT);
    expect(contractRecord?.failedAt).toBeUndefined();

    await expect(runner.rollback(run.runId)).rejects.toThrow(BadRequestException);
  });

  it('refuses to roll back a run that is still in progress', async () => {
    fake.totalRows = 2;
    const inFlight = runner.run(fake.name, { batchSize: 1, batchDelayMs: 20 });
    const [run] = await runner.findAll();

    await expect(runner.rollback(run.runId)).rejects.toThrow(ConflictException);

    await inFlight;
  });

  it('throws NotFoundException for an unregistered migration name', async () => {
    await expect(runner.run('does-not-exist')).rejects.toThrow(NotFoundException);
  });

  it('throws NotFoundException for an unknown run id', async () => {
    await expect(runner.findById('mig-unknown')).rejects.toThrow(NotFoundException);
  });

  describe('markApplied', () => {
    it('creates a completed migration run with mandatory audit note', async () => {
      const run = await runner.markApplied(fake.name, {
        reason: 'Applied manually via DB console during outage recovery',
      });

      expect(run.status).toBe(MigrationStatus.COMPLETED);
      expect(run.migrationName).toBe(fake.name);
      expect(run.auditNote).toBe('Applied manually via DB console during outage recovery');
      expect(run.stepHistory).toHaveLength(3);

      const retrieved = await runner.findById(run.runId);
      expect(retrieved.status).toBe(MigrationStatus.COMPLETED);
      expect(retrieved.auditNote).toBe('Applied manually via DB console during outage recovery');
    });

    it('rejects when audit note is missing or empty', async () => {
      await expect(
        runner.markApplied(fake.name, { reason: '   ' }),
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects when migration is not registered', async () => {
      await expect(
        runner.markApplied('unregistered-migration', { reason: 'Recovery' }),
      ).rejects.toThrow(NotFoundException);
    });
  });
});
