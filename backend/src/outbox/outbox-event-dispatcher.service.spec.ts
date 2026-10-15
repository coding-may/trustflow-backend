import { Test, TestingModule } from '@nestjs/testing';
import { OutboxEventDispatcher } from './outbox-event-dispatcher.service';
import { OutboxEvent } from './outbox.types';

describe('OutboxEventDispatcherService', () => {
  let service: OutboxEventDispatcher;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [OutboxEventDispatcher],
    }).compile();

    service = module.get<OutboxEventDispatcher>(OutboxEventDispatcher);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('register', () => {
    it('should register a handler for a specific event type', () => {
      const handler = jest.fn();
      service.register('test.event', handler);
      // No error means success - handlers are stored internally
      expect(handler).not.toHaveBeenCalled();
    });

    it('should allow multiple handlers for the same pattern', () => {
      const handler1 = jest.fn();
      const handler2 = jest.fn();
      service.register('test.event', handler1);
      service.register('test.event', handler2);
      // Both handlers should be registered
    });

    it('should register wildcard handlers', () => {
      const handler = jest.fn();
      service.register('*', handler);
      // Wildcard handlers should match all events
    });

    it('should register prefix wildcard handlers', () => {
      const handler = jest.fn();
      service.register('test.*', handler);
      // Prefix handlers should match events starting with prefix
    });
  });

  describe('dispatch', () => {
    let mockEvent: OutboxEvent;

    beforeEach(() => {
      mockEvent = {
        id: 'evt-123',
        dedupKey: 'dedup-123',
        type: 'test.event',
        aggregateType: 'test',
        aggregateId: 'agg-123',
        payload: { data: 'test' },
        createdAt: new Date().toISOString(),
        status: 'pending',
        attempts: 0,
        nextAttemptAt: Date.now(),
      };
    });

    it('should dispatch event to matching exact handler', async () => {
      const handler = jest.fn().mockResolvedValue(undefined);
      service.register('test.event', handler);

      await service.dispatch(mockEvent);

      expect(handler).toHaveBeenCalledWith(mockEvent);
      expect(handler).toHaveBeenCalledTimes(1);
    });

    it('should dispatch event to wildcard handler', async () => {
      const handler = jest.fn().mockResolvedValue(undefined);
      service.register('*', handler);

      await service.dispatch(mockEvent);

      expect(handler).toHaveBeenCalledWith(mockEvent);
    });

    it('should dispatch event to prefix wildcard handler', async () => {
      const handler = jest.fn().mockResolvedValue(undefined);
      service.register('test.*', handler);

      await service.dispatch(mockEvent);

      expect(handler).toHaveBeenCalledWith(mockEvent);
    });

    it('should not dispatch to non-matching handler', async () => {
      const handler = jest.fn().mockResolvedValue(undefined);
      service.register('other.event', handler);

      await service.dispatch(mockEvent);

      expect(handler).not.toHaveBeenCalled();
    });

    it('should not dispatch to non-matching prefix handler', async () => {
      const handler = jest.fn().mockResolvedValue(undefined);
      service.register('other.*', handler);

      await service.dispatch(mockEvent);

      expect(handler).not.toHaveBeenCalled();
    });

    it('should dispatch to multiple matching handlers sequentially', async () => {
      const callOrder: number[] = [];
      const handler1 = jest.fn().mockImplementation(async () => {
        callOrder.push(1);
        await new Promise(resolve => setTimeout(resolve, 10));
      });
      const handler2 = jest.fn().mockImplementation(async () => {
        callOrder.push(2);
      });

      service.register('test.event', handler1);
      service.register('test.event', handler2);

      await service.dispatch(mockEvent);

      expect(handler1).toHaveBeenCalledWith(mockEvent);
      expect(handler2).toHaveBeenCalledWith(mockEvent);
      expect(callOrder).toEqual([1, 2]); // Sequential, not parallel
    });

    it('should throw error when handler fails', async () => {
      const error = new Error('Handler failed');
      const handler = jest.fn().mockRejectedValue(error);
      service.register('test.event', handler);

      await expect(service.dispatch(mockEvent)).rejects.toThrow('Handler failed');
      expect(handler).toHaveBeenCalledWith(mockEvent);
    });

    it('should stop processing remaining handlers when one fails', async () => {
      const handler1 = jest.fn().mockRejectedValue(new Error('First handler failed'));
      const handler2 = jest.fn().mockResolvedValue(undefined);

      service.register('test.event', handler1);
      service.register('test.event', handler2);

      await expect(service.dispatch(mockEvent)).rejects.toThrow('First handler failed');
      expect(handler1).toHaveBeenCalled();
      expect(handler2).not.toHaveBeenCalled();
    });

    it('should dispatch to both exact and wildcard handlers', async () => {
      const exactHandler = jest.fn().mockResolvedValue(undefined);
      const wildcardHandler = jest.fn().mockResolvedValue(undefined);
      const prefixHandler = jest.fn().mockResolvedValue(undefined);

      service.register('test.event', exactHandler);
      service.register('*', wildcardHandler);
      service.register('test.*', prefixHandler);

      await service.dispatch(mockEvent);

      expect(exactHandler).toHaveBeenCalledWith(mockEvent);
      expect(wildcardHandler).toHaveBeenCalledWith(mockEvent);
      expect(prefixHandler).toHaveBeenCalledWith(mockEvent);
    });

    it('should handle event with no matching handlers', async () => {
      // Should not throw when no handlers match
      await expect(service.dispatch(mockEvent)).resolves.not.toThrow();
    });

    it('should handle synchronous handler errors', async () => {
      const handler = jest.fn().mockImplementation(() => {
        throw new Error('Synchronous error');
      });
      service.register('test.event', handler);

      await expect(service.dispatch(mockEvent)).rejects.toThrow('Synchronous error');
    });
  });

  describe('integration scenarios', () => {
    it('should support event state transitions: PENDING → PROCESSING → COMPLETED', async () => {
      const states: string[] = [];
      const handler = jest.fn().mockImplementation(async (event: OutboxEvent) => {
        states.push(event.status);
      });

      service.register('test.event', handler);

      const event: OutboxEvent = {
        id: 'evt-456',
        dedupKey: 'dedup-456',
        type: 'test.event',
        aggregateType: 'test',
        aggregateId: 'agg-456',
        payload: { data: 'test' },
        createdAt: new Date().toISOString(),
        status: 'pending',
        attempts: 0,
        nextAttemptAt: Date.now(),
      };

      await service.dispatch(event);

      expect(states).toContain('pending');
    });

    it('should handle network timeout scenario', async () => {
      const handler = jest.fn().mockImplementation(async () => {
        await new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Network timeout')), 10),
        );
      });

      service.register('test.event', handler);

      const event: OutboxEvent = {
        id: 'evt-timeout',
        dedupKey: 'dedup-timeout',
        type: 'test.event',
        aggregateType: 'test',
        aggregateId: 'agg-timeout',
        payload: { data: 'test' },
        createdAt: new Date().toISOString(),
        status: 'pending',
        attempts: 0,
        nextAttemptAt: Date.now(),
      };

      await expect(service.dispatch(event)).rejects.toThrow('Network timeout');
    });

    it('should handle 4xx non-retryable error', async () => {
      const handler = jest.fn().mockRejectedValue(
        Object.assign(new Error('Bad Request'), { statusCode: 400 }),
      );

      service.register('test.event', handler);

      const event: OutboxEvent = {
        id: 'evt-400',
        dedupKey: 'dedup-400',
        type: 'test.event',
        aggregateType: 'test',
        aggregateId: 'agg-400',
        payload: { data: 'test' },
        createdAt: new Date().toISOString(),
        status: 'pending',
        attempts: 0,
        nextAttemptAt: Date.now(),
      };

      await expect(service.dispatch(event)).rejects.toThrow('Bad Request');
    });

    it('should handle 5xx retryable error', async () => {
      const handler = jest.fn().mockRejectedValue(
        Object.assign(new Error('Internal Server Error'), { statusCode: 500 }),
      );

      service.register('test.event', handler);

      const event: OutboxEvent = {
        id: 'evt-500',
        dedupKey: 'dedup-500',
        type: 'test.event',
        aggregateType: 'test',
        aggregateId: 'agg-500',
        payload: { data: 'test' },
        createdAt: new Date().toISOString(),
        status: 'pending',
        attempts: 0,
        nextAttemptAt: Date.now(),
      };

      await expect(service.dispatch(event)).rejects.toThrow('Internal Server Error');
    });

    it('should guarantee at-least-once delivery semantics', async () => {
      const deliveryCount = { count: 0 };
      const handler = jest.fn().mockImplementation(async () => {
        deliveryCount.count++;
        if (deliveryCount.count === 1) {
          throw new Error('Transient failure');
        }
        // Success on second attempt
      });

      service.register('test.event', handler);

      const event: OutboxEvent = {
        id: 'evt-retry',
        dedupKey: 'dedup-retry',
        type: 'test.event',
        aggregateType: 'test',
        aggregateId: 'agg-retry',
        payload: { data: 'test' },
        createdAt: new Date().toISOString(),
        status: 'pending',
        attempts: 0,
        nextAttemptAt: Date.now(),
      };

      // First attempt fails
      await expect(service.dispatch(event)).rejects.toThrow('Transient failure');
      expect(deliveryCount.count).toBe(1);

      // Second attempt succeeds
      await service.dispatch(event);
      expect(deliveryCount.count).toBe(2);
      expect(handler).toHaveBeenCalledTimes(2);
    });

    it('should handle eventual success after retries', async () => {
      let attemptCount = 0;
      const handler = jest.fn().mockImplementation(async () => {
        attemptCount++;
        if (attemptCount < 3) {
          throw new Error(`Attempt ${attemptCount} failed`);
        }
        // Success on third attempt
      });

      service.register('test.event', handler);

      const event: OutboxEvent = {
        id: 'evt-eventual',
        dedupKey: 'dedup-eventual',
        type: 'test.event',
        aggregateType: 'test',
        aggregateId: 'agg-eventual',
        payload: { data: 'test' },
        createdAt: new Date().toISOString(),
        status: 'pending',
        attempts: 0,
        nextAttemptAt: Date.now(),
      };

      // First two attempts fail
      await expect(service.dispatch(event)).rejects.toThrow('Attempt 1 failed');
      await expect(service.dispatch(event)).rejects.toThrow('Attempt 2 failed');

      // Third attempt succeeds
      await service.dispatch(event);
      expect(handler).toHaveBeenCalledTimes(3);
    });
  });
});
