import { Test, TestingModule } from '@nestjs/testing';
import { GigController } from './gig.controller';
import { GigService } from './gig.service';
import { GigStatus } from './gig.entity';

describe('GigController', () => {
  let controller: GigController;

  const mockGigService = {
    create: jest.fn(),
    search: jest.fn(),
    findById: jest.fn(),
    findByCreator: jest.fn(),
    accept: jest.fn(),
    cancel: jest.fn(),
    update: jest.fn(),
  };

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      controllers: [GigController],
      providers: [{ provide: GigService, useValue: mockGigService }],
    }).compile();

    controller = module.get<GigController>(GigController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  describe('create', () => {
    const dto = {
      creator: 'GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
      title: 'Build a Soroban escrow audit report',
      budgetXLM: '250',
    };

    it('creates the gig via the service; durable delivery is handled by the outbox relay', async () => {
      const gig = { id: 'gig-1', ...dto, status: GigStatus.OPEN };
      mockGigService.create.mockResolvedValue(gig);

      const result = await controller.create(dto);

      expect(result).toEqual(gig);
      expect(mockGigService.create).toHaveBeenCalledWith(dto);
    });

    it('rejects an invalid creator address before hitting the service', async () => {
      await expect(
        controller.create({ ...dto, creator: 'not-a-stellar-address' }),
      ).rejects.toThrow();
      expect(mockGigService.create).not.toHaveBeenCalled();
    });
  });

  describe('search', () => {
    it('validates and delegates the query to the service', async () => {
      const page = { items: [{ id: 'gig-1' }], total: 1, page: 1, limit: 20 };
      mockGigService.search.mockResolvedValue(page);

      const result = await controller.search({
        status: GigStatus.OPEN,
        page: '2',
        limit: '10',
      } as any);

      expect(result).toEqual(page);
      expect(mockGigService.search).toHaveBeenCalledWith({
        status: GigStatus.OPEN,
        page: 2,
        limit: 10,
      });
    });

    it('delegates with defaults when no query params are given', async () => {
      mockGigService.search.mockResolvedValue({ items: [], total: 0, page: 1, limit: 20 });

      await controller.search({});

      expect(mockGigService.search).toHaveBeenCalledWith({});
    });

    it('rejects an invalid status before hitting the service', async () => {
      await expect(controller.search({ status: 'not-a-status' } as any)).rejects.toThrow();
      expect(mockGigService.search).not.toHaveBeenCalled();
    });

    it('rejects a limit above the maximum before hitting the service', async () => {
      await expect(controller.search({ limit: '500' } as any)).rejects.toThrow();
      expect(mockGigService.search).not.toHaveBeenCalled();
    });
  });

  describe('findOne', () => {
    it('delegates to the service', async () => {
      mockGigService.findById.mockResolvedValue({ id: 'gig-1' });
      await expect(controller.findOne('gig-1')).resolves.toEqual({ id: 'gig-1' });
      expect(mockGigService.findById).toHaveBeenCalledWith('gig-1');
    });
  });

  describe('findByCreator', () => {
    it('delegates to the service with default pagination', async () => {
      mockGigService.findByCreator.mockResolvedValue({ data: [{ id: 'gig-1' }], total: 1 });
      const address = 'GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX';

      const result = await controller.findByCreator(address);

      expect(result).toEqual({ data: [{ id: 'gig-1' }], total: 1 });
      expect(mockGigService.findByCreator).toHaveBeenCalledWith(address, {
        status: undefined,
        minBudgetXLM: undefined,
        maxBudgetXLM: undefined,
        offset: 0,
        limit: 20,
      });
    });

    it('applies custom pagination and filters', async () => {
      mockGigService.findByCreator.mockResolvedValue({ data: [], total: 0 });
      const address = 'GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX';

      await controller.findByCreator(address, GigStatus.OPEN, '10', '100', 5, 10);

      expect(mockGigService.findByCreator).toHaveBeenCalledWith(address, {
        status: GigStatus.OPEN,
        minBudgetXLM: '10',
        maxBudgetXLM: '100',
        offset: 5,
        limit: 10,
      });
    });

    it('clamps limit to max 100', async () => {
      mockGigService.findByCreator.mockResolvedValue({ data: [], total: 0 });
      const address = 'GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX';

      await controller.findByCreator(address, undefined, undefined, undefined, 0, 500);

      expect(mockGigService.findByCreator).toHaveBeenCalledWith(address, {
        status: undefined,
        minBudgetXLM: undefined,
        maxBudgetXLM: undefined,
        offset: 0,
        limit: 100,
      });
    });
  });

  describe('accept', () => {
    it('accepts via the service; durable delivery is handled by the outbox relay', async () => {
      const responder = 'GYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYY';
      const gig = { id: 'gig-1', status: GigStatus.ACCEPTED, acceptedBy: responder };
      mockGigService.accept.mockResolvedValue(gig);

      const result = await controller.accept('gig-1', { responder });

      expect(result).toEqual(gig);
      expect(mockGigService.accept).toHaveBeenCalledWith('gig-1', responder);
    });
  });

  describe('cancel', () => {
    it('cancels via the service; durable delivery is handled by the outbox relay', async () => {
      const gig = { id: 'gig-1', status: GigStatus.CANCELLED };
      mockGigService.cancel.mockResolvedValue(gig);

      const result = await controller.cancel('gig-1');

      expect(result).toEqual(gig);
      expect(mockGigService.cancel).toHaveBeenCalledWith('gig-1');
    });
  });

  describe('update', () => {
    it('validates and forwards responseWindowHours to the service (#432)', async () => {
      const gig = { id: 'gig-1', title: 'New title', status: GigStatus.OPEN };
      mockGigService.update.mockResolvedValue(gig);

      const result = await controller.update('gig-1', {
        title: 'New title',
        responseWindowHours: 12,
      } as any);

      expect(result).toEqual(gig);
      expect(mockGigService.update).toHaveBeenCalledWith('gig-1', {
        title: 'New title',
        responseWindowHours: 12,
      });
    });

    it('rejects a non-positive responseWindowHours before hitting the service', async () => {
      await expect(controller.update('gig-1', { responseWindowHours: 0 } as any)).rejects.toThrow();
      expect(mockGigService.update).not.toHaveBeenCalled();
    });

    it('rejects a responseWindowHours beyond the 30-day cap before hitting the service', async () => {
      await expect(
        controller.update('gig-1', { responseWindowHours: 24 * 30 + 1 } as any),
      ).rejects.toThrow();
      expect(mockGigService.update).not.toHaveBeenCalled();
    });
  });
});
