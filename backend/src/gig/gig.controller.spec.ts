import { Test, TestingModule } from '@nestjs/testing';
import { GigController } from './gig.controller';
import { GigService } from './gig.service';
import { GigStatus } from './gig.entity';
import { ForbiddenException, NotFoundException, BadRequestException } from '@nestjs/common';

/**
 * Mock authenticated request matching the shape expected by the controller.
 */
interface AuthenticatedRequest {
  user: { address: string; sub: string };
}

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
    remove: jest.fn(),
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
    const creatorAddress = 'GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX';
    const dto = {
      creator: creatorAddress,
      title: 'Build a Soroban escrow audit report',
      budgetXLM: '250',
    };

    const mockReq: AuthenticatedRequest = {
      user: { address: creatorAddress, sub: 'user-123' },
    };

    it('creates the gig via the service; durable delivery is handled by the outbox relay', async () => {
      const gig = { id: 'gig-1', ...dto, status: GigStatus.OPEN };
      mockGigService.create.mockResolvedValue(gig);

      const result = await controller.create(dto, mockReq);

      expect(result).toEqual(gig);
      expect(mockGigService.create).toHaveBeenCalledWith(dto);
    });

    it('rejects an invalid creator address before hitting the service', async () => {
      await expect(
        controller.create({ ...dto, creator: 'not-a-stellar-address' }, mockReq),
      ).rejects.toThrow();
      expect(mockGigService.create).not.toHaveBeenCalled();
    });

    it('throws ForbiddenException when creator does not match authenticated wallet', async () => {
      const differentUser: AuthenticatedRequest = {
        user: { address: 'GDIFFERENTADDRESSXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX', sub: 'user-456' },
      };

      await expect(controller.create(dto, differentUser)).rejects.toThrow(ForbiddenException);
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

    it('rejects an unrecognized category with 400 validation error', async () => {
      await expect(controller.search({ category: 'nonexistent' })).rejects.toThrow(BadRequestException);
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
    const creatorAddress = 'GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX';
    const responderAddress = 'GYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYY';

    const mockReq: AuthenticatedRequest = {
      user: { address: responderAddress, sub: 'responder-123' },
    };

    it('accepts via the service; durable delivery is handled by the outbox relay', async () => {
      const gig = {
        id: 'gig-1',
        creator: creatorAddress,
        status: GigStatus.OPEN,
        acceptedBy: undefined,
      };
      mockGigService.findById.mockResolvedValue(gig);

      const acceptedGig = { ...gig, status: GigStatus.ACCEPTED, acceptedBy: responderAddress };
      mockGigService.accept.mockResolvedValue(acceptedGig);

      const result = await controller.accept('gig-1', { responder: responderAddress }, mockReq);

      expect(result).toEqual(acceptedGig);
      expect(mockGigService.accept).toHaveBeenCalledWith('gig-1', responderAddress);
    });

    it('throws ForbiddenException when responder does not match authenticated wallet', async () => {
      const gig = {
        id: 'gig-1',
        creator: creatorAddress,
        status: GigStatus.OPEN,
      };
      mockGigService.findById.mockResolvedValue(gig);

      const differentUser: AuthenticatedRequest = {
        user: { address: 'GDIFFERENTADDRESSXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX', sub: 'user-789' },
      };

      await expect(
        controller.accept('gig-1', { responder: responderAddress }, differentUser),
      ).rejects.toThrow(ForbiddenException);
      expect(mockGigService.accept).not.toHaveBeenCalled();
    });

    it('throws BadRequestException when trying to accept own gig', async () => {
      const gig = {
        id: 'gig-1',
        creator: creatorAddress,
        status: GigStatus.OPEN,
      };
      mockGigService.findById.mockResolvedValue(gig);

      const creatorReq: AuthenticatedRequest = {
        user: { address: creatorAddress, sub: 'creator-123' },
      };

      await expect(
        controller.accept('gig-1', { responder: creatorAddress }, creatorReq),
      ).rejects.toThrow(BadRequestException);
      expect(mockGigService.accept).not.toHaveBeenCalled();
    });

    it('throws NotFoundException when gig does not exist', async () => {
      mockGigService.findById.mockResolvedValue(null);

      await expect(
        controller.accept('gig-999', { responder: responderAddress }, mockReq),
      ).rejects.toThrow(NotFoundException);
      expect(mockGigService.accept).not.toHaveBeenCalled();
    });
  });

  describe('cancel', () => {
    const creatorAddress = 'GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX';

    const mockReq: AuthenticatedRequest = {
      user: { address: creatorAddress, sub: 'creator-123' },
    };

    it('cancels via the service; durable delivery is handled by the outbox relay', async () => {
      const gig = { id: 'gig-1', creator: creatorAddress, status: GigStatus.OPEN };
      mockGigService.findById.mockResolvedValue(gig);

      const cancelledGig = { ...gig, status: GigStatus.CANCELLED };
      mockGigService.cancel.mockResolvedValue(cancelledGig);

      const result = await controller.cancel('gig-1', mockReq);

      expect(result).toEqual(cancelledGig);
      expect(mockGigService.cancel).toHaveBeenCalledWith('gig-1');
    });

    it('throws ForbiddenException when user is not the creator', async () => {
      const gig = { id: 'gig-1', creator: creatorAddress, status: GigStatus.OPEN };
      mockGigService.findById.mockResolvedValue(gig);

      const differentUser: AuthenticatedRequest = {
        user: { address: 'GDIFFERENTADDRESSXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX', sub: 'user-456' },
      };

      await expect(controller.cancel('gig-1', differentUser)).rejects.toThrow(ForbiddenException);
      expect(mockGigService.cancel).not.toHaveBeenCalled();
    });

    it('throws NotFoundException when gig does not exist', async () => {
      mockGigService.findById.mockResolvedValue(null);

      await expect(controller.cancel('gig-999', mockReq)).rejects.toThrow(NotFoundException);
      expect(mockGigService.cancel).not.toHaveBeenCalled();
    });
  });

  describe('update', () => {
    const creatorAddress = 'GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX';

    const mockReq: AuthenticatedRequest = {
      user: { address: creatorAddress, sub: 'creator-123' },
    };

    it('validates and forwards responseWindowHours to the service (#432)', async () => {
      const gig = { id: 'gig-1', creator: creatorAddress, title: 'Old title', status: GigStatus.OPEN };
      mockGigService.findById.mockResolvedValue(gig);

      const updatedGig = { ...gig, title: 'New title' };
      mockGigService.update.mockResolvedValue(updatedGig);

      const result = await controller.update(
        'gig-1',
        {
          title: 'New title',
          responseWindowHours: 12,
        } as any,
        mockReq,
      );

      expect(result).toEqual(updatedGig);
      expect(mockGigService.update).toHaveBeenCalledWith('gig-1', {
        title: 'New title',
        responseWindowHours: 12,
      });
    });

    it('rejects a non-positive responseWindowHours before hitting the service', async () => {
      const gig = { id: 'gig-1', creator: creatorAddress, status: GigStatus.OPEN };
      mockGigService.findById.mockResolvedValue(gig);

      await expect(
        controller.update('gig-1', { responseWindowHours: 0 } as any, mockReq),
      ).rejects.toThrow();
      expect(mockGigService.update).not.toHaveBeenCalled();
    });

    it('rejects a responseWindowHours beyond the 30-day cap before hitting the service', async () => {
      const gig = { id: 'gig-1', creator: creatorAddress, status: GigStatus.OPEN };
      mockGigService.findById.mockResolvedValue(gig);

      await expect(
        controller.update('gig-1', { responseWindowHours: 24 * 30 + 1 } as any, mockReq),
      ).rejects.toThrow();
      expect(mockGigService.update).not.toHaveBeenCalled();
    });

    it('throws ForbiddenException when user is not the creator', async () => {
      const gig = { id: 'gig-1', creator: creatorAddress, status: GigStatus.OPEN };
      mockGigService.findById.mockResolvedValue(gig);

      const differentUser: AuthenticatedRequest = {
        user: { address: 'GDIFFERENTADDRESSXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX', sub: 'user-456' },
      };

      await expect(
        controller.update('gig-1', { title: 'New title' } as any, differentUser),
      ).rejects.toThrow(ForbiddenException);
      expect(mockGigService.update).not.toHaveBeenCalled();
    });

    it('throws NotFoundException when gig does not exist', async () => {
      mockGigService.findById.mockResolvedValue(null);

      await expect(
        controller.update('gig-999', { title: 'New title' } as any, mockReq),
      ).rejects.toThrow(NotFoundException);
      expect(mockGigService.update).not.toHaveBeenCalled();
    });
  });
});
