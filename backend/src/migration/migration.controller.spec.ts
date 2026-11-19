import { BadRequestException, ExecutionContext, ValidationPipe } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { Test, TestingModule } from '@nestjs/testing';
import { MigrationController } from './migration.controller';
import { MigrationRunnerService } from './migration-runner.service';
import { MigrationRegistryService } from './migration-registry.service';
import { RunMigrationDto } from './migration.dto';
import { JwtAuthGuard } from '../auth/auth.guard';
import { AdminGuard } from '../admin/admin.guard';
import { validateEnv } from '../config/env.config';

// AdminGuard reads config.ADMIN_ADDRESSES, which requires validateEnv() to have run first —
// normally done once in main.ts.
validateEnv();

function contextForAddress(address: string | undefined): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => ({ user: address === undefined ? undefined : { address } }),
    }),
  } as unknown as ExecutionContext;
}

/**
 * config.ADMIN_ADDRESSES is cached at module scope by the first validateEnv() call in this
 * process, so mutating process.env.ADMIN_ADDRESSES afterwards has no effect on the AdminGuard
 * imported above. Build a guard bound to a freshly validated, isolated copy of env.config
 * instead, matching the pattern used in config/env.config.spec.ts.
 */
function freshAdminGuard(adminAddresses: string | undefined): AdminGuard {
  let guard!: AdminGuard;
  jest.isolateModules(() => {
    if (adminAddresses === undefined) {
      delete process.env.ADMIN_ADDRESSES;
    } else {
      process.env.ADMIN_ADDRESSES = adminAddresses;
    }
    const { validateEnv: freshValidateEnv } = jest.requireActual('../config/env.config');
    freshValidateEnv();
    const { AdminGuard: FreshAdminGuard } = jest.requireActual('../admin/admin.guard');
    guard = new FreshAdminGuard();
  });
  return guard;
}

describe('MigrationController', () => {
  let controller: MigrationController;
  const ORIGINAL_ADMIN_ADDRESSES = process.env.ADMIN_ADDRESSES;

  const mockRunner = {
    findAll: jest.fn(),
    findById: jest.fn(),
    run: jest.fn(),
    rollback: jest.fn(),
    markApplied: jest.fn(),
  };

  const mockRegistry = {
    list: jest.fn(),
  };

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      controllers: [MigrationController],
      providers: [
        { provide: MigrationRunnerService, useValue: mockRunner },
        { provide: MigrationRegistryService, useValue: mockRegistry },
      ],
    }).compile();

    controller = module.get<MigrationController>(MigrationController);
  });

  afterEach(() => {
    if (ORIGINAL_ADMIN_ADDRESSES === undefined) {
      delete process.env.ADMIN_ADDRESSES;
    } else {
      process.env.ADMIN_ADDRESSES = ORIGINAL_ADMIN_ADDRESSES;
    }
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  it('listDefinitions delegates to the registry', () => {
    mockRegistry.list.mockReturnValue([{ name: 'gigs-add-priority-column' }]);
    expect(controller.listDefinitions()).toEqual([{ name: 'gigs-add-priority-column' }]);
    expect(mockRegistry.list).toHaveBeenCalled();
  });

  it('listRuns delegates to the runner', () => {
    mockRunner.findAll.mockReturnValue([{ runId: 'mig-1' }]);
    expect(controller.listRuns()).toEqual([{ runId: 'mig-1' }]);
  });

  it('getRun delegates to the runner with the run id', () => {
    mockRunner.findById.mockReturnValue({ runId: 'mig-1' });
    expect(controller.getRun('mig-1')).toEqual({ runId: 'mig-1' });
    expect(mockRunner.findById).toHaveBeenCalledWith('mig-1');
  });

  it('run delegates to the runner with the migration name and options', async () => {
    const dto = { batchSize: 250 };
    mockRunner.run.mockResolvedValue({ runId: 'mig-1' });

    await controller.run('gigs-add-priority-column', dto);

    expect(mockRunner.run).toHaveBeenCalledWith('gigs-add-priority-column', dto);
  });

  it('forwards dryRun through to the runner', async () => {
    const dto = { dryRun: true };
    mockRunner.run.mockResolvedValue({ runId: 'mig-1' });

    await controller.run('gigs-add-priority-column', dto);

    expect(mockRunner.run).toHaveBeenCalledWith('gigs-add-priority-column', {
      dryRun: true,
    });
  });

  describe('RunMigrationDto validation', () => {
    const pipe = new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: true,
    });

    function transform(body: Record<string, unknown>) {
      return pipe.transform(body, { type: 'body', metatype: RunMigrationDto });
    }

    it('accepts dryRun as a boolean', async () => {
      const dto = (await transform({ dryRun: true })) as RunMigrationDto;

      expect(dto).toBeInstanceOf(RunMigrationDto);
      expect(dto.dryRun).toBe(true);
    });

    it('rejects a non-boolean dryRun', async () => {
      await expect(transform({ dryRun: 'yes' })).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('markApplied()', () => {
    it('delegates to the runner with migration name and dto', async () => {
      const dto = { reason: 'Applied manually during incident' };
      mockRunner.markApplied.mockResolvedValue({
        runId: 'mig-1',
        migrationName: 'gigs-add-priority-column',
        status: 'COMPLETED',
        auditNote: 'Applied manually during incident',
      });

      const result = await controller.markApplied('gigs-add-priority-column', dto);

      expect(mockRunner.markApplied).toHaveBeenCalledWith('gigs-add-priority-column', dto);
      expect(result.status).toBe('COMPLETED');
    });
  });

  it('rollback delegates to the runner with the run id', async () => {
    mockRunner.rollback.mockResolvedValue({ runId: 'mig-1', status: 'ROLLED_BACK' });

    const result = await controller.rollback('mig-1');

    expect(mockRunner.rollback).toHaveBeenCalledWith('mig-1');
    expect(result).toEqual({ runId: 'mig-1', status: 'ROLLED_BACK' });
  });

  describe('access control', () => {
    it('requires JwtAuthGuard and AdminGuard on every route', () => {
      const guards = Reflect.getMetadata(GUARDS_METADATA, MigrationController);

      expect(guards).toEqual([JwtAuthGuard, AdminGuard]);
    });

    it('AdminGuard rejects a non-admin caller on run', async () => {
      const guard = freshAdminGuard('GADMIN1');

      expect(() => guard.canActivate(contextForAddress('GNOTADMIN'))).toThrow(
        'Admin access required',
      );
      expect(mockRunner.run).not.toHaveBeenCalled();
    });

    it('AdminGuard rejects a non-admin caller on rollback', async () => {
      const guard = freshAdminGuard('GADMIN1');

      expect(() => guard.canActivate(contextForAddress('GNOTADMIN'))).toThrow(
        'Admin access required',
      );
      expect(mockRunner.rollback).not.toHaveBeenCalled();
    });

    it('AdminGuard admits an allow-listed admin through to the runner on run', async () => {
      const guard = freshAdminGuard('GADMIN1');
      mockRunner.run.mockResolvedValue({ runId: 'mig-1' });

      expect(guard.canActivate(contextForAddress('GADMIN1'))).toBe(true);
      await controller.run('gigs-add-priority-column', { batchSize: 250 });

      expect(mockRunner.run).toHaveBeenCalledWith('gigs-add-priority-column', {
        batchSize: 250,
      });
    });

    it('AdminGuard admits an allow-listed admin through to the runner on rollback', async () => {
      const guard = freshAdminGuard('GADMIN1');
      mockRunner.rollback.mockResolvedValue({ runId: 'mig-1', status: 'ROLLED_BACK' });

      expect(guard.canActivate(contextForAddress('GADMIN1'))).toBe(true);
      await controller.rollback('mig-1');

      expect(mockRunner.rollback).toHaveBeenCalledWith('mig-1');
    });
  });
});
