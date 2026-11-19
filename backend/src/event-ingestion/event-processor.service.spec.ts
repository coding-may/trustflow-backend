import { Test, TestingModule } from '@nestjs/testing';
import {
  EVENTS_DEAD_LETTERED_TOTAL,
  EVENTS_INGESTED_TOTAL,
  EventProcessorService,
  SorobanEvent,
  getEventIdentity,
} from './event-processor.service';
import { EscrowService } from '../escrow/escrow.service';

describe('EventProcessorService', () => {
  let service: EventProcessorService;

  const mockEscrowService = {
    create: jest.fn().mockResolvedValue({ id: 'esc-123', status: 'pending' }),
    createFromChainState: jest.fn().mockResolvedValue({
      id: 'esc-123',
      status: 'pending',
      contractEscrowId: 'contract-esc-123',
    }),
    findById: jest.fn().mockResolvedValue({ id: 'esc-123', status: 'pending' }),
    findByContractEscrowId: jest.fn().mockResolvedValue({
      id: 'esc-123',
      status: 'pending',
      contractEscrowId: 'contract-esc-123',
    }),
    release: jest.fn().mockResolvedValue({ id: 'esc-123', status: 'released' }),
    raiseDispute: jest.fn().mockResolvedValue({ id: 'esc-123', status: 'disputed' }),
    fund: jest.fn().mockResolvedValue({ id: 'esc-123', status: 'active' }),
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [EventProcessorService, { provide: EscrowService, useValue: mockEscrowService }],
    }).compile();

    service = module.get<EventProcessorService>(EventProcessorService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('processEvent', () => {
    it('should process escrow_created event', async () => {
      mockEscrowService.findByContractEscrowId.mockResolvedValueOnce(undefined);
      const event: SorobanEvent = {
        id: 'event-1',
        ledger: 100,
        contractId: 'test-contract',
        eventType: 'escrow_created',
        topic: ['escrow_created', 'contract-esc-123'],
        value: {
          contractEscrowId: 'contract-esc-123',
          depositor: 'GABC...',
          beneficiary: 'GDEF...',
          amount: '100',
        },
        xdr: 'test-xdr',
        createdAt: new Date(),
      };

      const result = await service.processEvent(event);

      expect(result.success).toBe(true);
      expect(result.eventId).toBe('100-event-1');
      expect(mockEscrowService.createFromChainState).toHaveBeenCalledWith({
        contractEscrowId: 'contract-esc-123',
        depositor: 'GABC...',
        beneficiary: 'GDEF...',
        amountXLM: '100',
        status: 'pending',
      });
      expect(mockEscrowService.create).not.toHaveBeenCalled();
    });

    it('should not duplicate an escrow_created event already linked by contract id', async () => {
      const event: SorobanEvent = {
        id: 'event-existing',
        ledger: 100,
        contractId: 'test-contract',
        eventType: 'escrow_created',
        topic: ['escrow_created', 'contract-esc-123'],
        value: {
          depositor: 'GABC...',
          beneficiary: 'GDEF...',
          amount: '100',
        },
        xdr: 'test-xdr',
        createdAt: new Date(),
      };

      const result = await service.processEvent(event);

      expect(result.success).toBe(true);
      expect(mockEscrowService.findByContractEscrowId).toHaveBeenCalledWith('contract-esc-123');
      expect(mockEscrowService.createFromChainState).not.toHaveBeenCalled();
    });

    it('should process escrow_released event', async () => {
      const event: SorobanEvent = {
        id: 'event-2',
        ledger: 101,
        contractId: 'test-contract',
        eventType: 'escrow_released',
        topic: ['escrow_released', 'contract-esc-123'],
        value: {},
        xdr: 'test-xdr',
        createdAt: new Date(),
      };

      const result = await service.processEvent(event);

      expect(result.success).toBe(true);
      expect(mockEscrowService.release).toHaveBeenCalledWith('esc-123');
      expect(mockEscrowService.findByContractEscrowId).toHaveBeenCalledWith('contract-esc-123');
    });

    it('should process escrow_funded event', async () => {
      const event: SorobanEvent = {
        id: 'event-funded',
        ledger: 101,
        contractId: 'test-contract',
        eventType: 'escrow_funded',
        topic: ['escrow_funded', 'contract-esc-123'],
        value: {},
        xdr: 'test-xdr',
        createdAt: new Date(),
      };

      const result = await service.processEvent(event);

      expect(result.success).toBe(true);
      expect(mockEscrowService.fund).toHaveBeenCalledWith('esc-123');
      expect(mockEscrowService.findByContractEscrowId).toHaveBeenCalledWith('contract-esc-123');
    });

    it('should process escrow_disputed event', async () => {
      const event: SorobanEvent = {
        id: 'event-3',
        ledger: 102,
        contractId: 'test-contract',
        eventType: 'escrow_disputed',
        topic: ['escrow_disputed', 'contract-esc-123'],
        value: { reason: 'Service not delivered' },
        xdr: 'test-xdr',
        createdAt: new Date(),
      };

      const result = await service.processEvent(event);

      expect(result.success).toBe(true);
      expect(mockEscrowService.raiseDispute).toHaveBeenCalledWith(
        'esc-123',
        'Service not delivered',
      );
      expect(mockEscrowService.findByContractEscrowId).toHaveBeenCalledWith('contract-esc-123');
    });

    it('should fail lifecycle events when no DB row is linked to the contract escrow id', async () => {
      mockEscrowService.findByContractEscrowId.mockResolvedValueOnce(undefined);
      const event: SorobanEvent = {
        id: 'event-missing',
        ledger: 103,
        contractId: 'test-contract',
        eventType: 'escrow_funded',
        topic: ['escrow_funded', 'contract-missing'],
        value: {},
        xdr: 'test-xdr',
        createdAt: new Date(),
      };

      const result = await service.processEvent(event);

      expect(result.success).toBe(false);
      expect(result.error).toContain('No DB escrow linked to contract escrow id contract-missing');
      expect(mockEscrowService.fund).not.toHaveBeenCalled();
    });

    it('should skip already processed events', async () => {
      mockEscrowService.findByContractEscrowId.mockResolvedValueOnce(undefined);
      const event: SorobanEvent = {
        id: 'event-1',
        ledger: 100,
        contractId: 'test-contract',
        eventType: 'escrow_created',
        topic: ['escrow_created', 'contract-dup'],
        value: { depositor: 'GABC...', beneficiary: 'GDEF...', amount: '100' },
        xdr: 'test-xdr',
        createdAt: new Date(),
      };

      await service.processEvent(event);
      const result = await service.processEvent(event);

      expect(result.success).toBe(true);
      expect(mockEscrowService.createFromChainState).toHaveBeenCalledTimes(1);
    });
  });

  describe('ingestion metrics and dead-letter identity', () => {
    let metrics: { increment: jest.Mock };
    let serviceWithMetrics: EventProcessorService;

    beforeEach(() => {
      metrics = { increment: jest.fn() };
      serviceWithMetrics = new EventProcessorService(
        mockEscrowService as never,
        null,
        metrics as never,
      );
    });

    const successfulEvent = (): SorobanEvent => ({
      id: '0000000000000064-0000000000000001-0000000000000000',
      ledger: 100,
      contractId: 'test-contract',
      eventType: 'escrow_created',
      topic: ['escrow_created', 'contract-esc-123'],
      value: { depositor: 'GABC...', beneficiary: 'GDEF...', amount: '100' },
      xdr: 'test-xdr',
      createdAt: new Date(),
    });

    it('increments events_ingested_total once per successfully ingested event', async () => {
      mockEscrowService.findByContractEscrowId.mockResolvedValueOnce(undefined);

      const result = await serviceWithMetrics.processEvent(successfulEvent());

      expect(result.success).toBe(true);
      expect(metrics.increment).toHaveBeenCalledTimes(1);
      expect(metrics.increment).toHaveBeenCalledWith(EVENTS_INGESTED_TOTAL, {
        event_type: 'escrow_created',
      });
      expect(metrics.increment).not.toHaveBeenCalledWith(
        EVENTS_DEAD_LETTERED_TOTAL,
        expect.anything(),
      );
    });

    it('increments events_dead_lettered_total once per failed event, never the success counter', async () => {
      mockEscrowService.findByContractEscrowId.mockResolvedValueOnce(undefined);
      const event: SorobanEvent = {
        ...successfulEvent(),
        id: '0000000000000064-0000000000000001-0000000000000003',
        eventType: 'escrow_funded',
        topic: ['escrow_funded', 'contract-missing'],
      };

      const result = await serviceWithMetrics.processEvent(event);

      expect(result.success).toBe(false);
      expect(metrics.increment).toHaveBeenCalledTimes(1);
      expect(metrics.increment).toHaveBeenCalledWith(EVENTS_DEAD_LETTERED_TOTAL, {
        event_type: 'escrow_funded',
      });
      expect(metrics.increment).not.toHaveBeenCalledWith(EVENTS_INGESTED_TOTAL, expect.anything());
    });

    it('records the individual tx hash and event index that caused the failure', async () => {
      mockEscrowService.findByContractEscrowId.mockResolvedValueOnce(undefined);
      const event: SorobanEvent = {
        ...successfulEvent(),
        id: '0000000000000064-0000000000000002-0000000000000007',
        txHash: 'a1b2c3d4',
        eventType: 'escrow_funded',
        topic: ['escrow_funded', 'contract-missing'],
      };

      const result = await serviceWithMetrics.processEvent(event);

      expect(result.success).toBe(false);
      expect(result.txHash).toBe('a1b2c3d4');
      expect(result.eventIndex).toBe(7);
    });

    it('derives the tx identifier and event index from a Soroban event id', () => {
      expect(
        getEventIdentity({
          id: '0000000000000064-0000000000000002-000000000000000a',
        } as SorobanEvent),
      ).toEqual({
        txHash: '0000000000000064-0000000000000002',
        eventIndex: 10,
      });
    });
  });

  describe('isEventProcessed', () => {
    it('should return false for unprocessed event', async () => {
      const isProcessed = await service.isEventProcessed('100-event-1');
      expect(isProcessed).toBe(false);
    });

    it('should return true for processed event', async () => {
      const event: SorobanEvent = {
        id: 'event-1',
        ledger: 100,
        contractId: 'test-contract',
        eventType: 'escrow_created',
        topic: ['escrow_created', 'contract-1'],
        value: { depositor: 'GABC...', beneficiary: 'GDEF...', amount: '100' },
        xdr: 'test-xdr',
        createdAt: new Date(),
      };

      await service.processEvent(event);
      const isProcessed = await service.isEventProcessed('100-event-1');
      expect(isProcessed).toBe(true);
    });
  });

  describe('clearEventsBeforeLedger', () => {
    it('should clear events before specified ledger', async () => {
      const event1: SorobanEvent = {
        id: 'event-1',
        ledger: 100,
        contractId: 'test-contract',
        eventType: 'escrow_created',
        topic: ['escrow_created', 'contract-2'],
        value: { depositor: 'GABC...', beneficiary: 'GDEF...', amount: '100' },
        xdr: 'test-xdr',
        createdAt: new Date(),
      };

      const event2: SorobanEvent = {
        id: 'event-2',
        ledger: 105,
        contractId: 'test-contract',
        eventType: 'escrow_created',
        topic: ['escrow_created'],
        value: {},
        xdr: 'test-xdr',
        createdAt: new Date(),
      };

      await service.processEvent(event1);
      await service.processEvent(event2);

      const cleared = await service.clearEventsBeforeLedger(103);
      expect(cleared).toBe(1);
    });
  });
});
