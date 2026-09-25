import { Test, TestingModule } from '@nestjs/testing';
import { NonceStoreService } from './nonce-store.service';
import { REDIS_CLIENT } from '../common/redis/redis.module';

describe('NonceStoreService', () => {
  let service: NonceStoreService;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mockRedis: any;

  const TEST_ADDRESS = 'GABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890ABCDEFGHIJKLMNOP';
  const TEST_NONCE = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2';
  const TEST_CHALLENGE = `Sign this message to authenticate with TrustFlow: ${TEST_NONCE}`;

  beforeEach(async () => {
    mockRedis = {
      set: jest.fn(),
      get: jest.fn(),
      del: jest.fn(),
      exists: jest.fn(),
      eval: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [NonceStoreService, { provide: REDIS_CLIENT, useValue: mockRedis }],
    }).compile();

    service = module.get<NonceStoreService>(NonceStoreService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('with Redis', () => {
    describe('store', () => {
      it('should store challenge in Redis with TTL', async () => {
        mockRedis.set.mockResolvedValue('OK');

        await service.store(TEST_ADDRESS, TEST_CHALLENGE, TEST_NONCE);

        expect(mockRedis.set).toHaveBeenCalledWith(
          `auth:nonce:${TEST_ADDRESS}`,
          TEST_CHALLENGE,
          'EX',
          60,
          'NX',
        );
      });

      // #431: store() must never mark the nonce used — that happens only after a
      // successful signature check (AuthService.verifySignature -> markNonceUsed()).
      // Marking it here made every login fail as an immediate replay.
      it('should not mark the nonce as used', async () => {
        mockRedis.set.mockResolvedValue('OK');

        await service.store(TEST_ADDRESS, TEST_CHALLENGE, TEST_NONCE);

        expect(mockRedis.set).not.toHaveBeenCalledWith(
          `auth:nonce:used:${TEST_NONCE}`,
          expect.anything(),
          expect.anything(),
          expect.anything(),
        );

        mockRedis.exists.mockResolvedValue(0);
        expect(await service.isNonceReplay(TEST_NONCE)).toBe(false);
      });

      it('should replace existing challenge if NX fails', async () => {
        mockRedis.set.mockResolvedValueOnce(null).mockResolvedValueOnce('OK');

        await service.store(TEST_ADDRESS, TEST_CHALLENGE, TEST_NONCE);

        expect(mockRedis.set).toHaveBeenCalledTimes(2);
        expect(mockRedis.set).toHaveBeenCalledWith(
          `auth:nonce:${TEST_ADDRESS}`,
          TEST_CHALLENGE,
          'EX',
          60,
        );
      });

      it('should fallback to memory when Redis fails', async () => {
        const redisError = new Error('Redis down');
        mockRedis.set.mockRejectedValue(redisError);
        mockRedis.exists.mockRejectedValue(redisError);

        await service.store(TEST_ADDRESS, TEST_CHALLENGE, TEST_NONCE);

        const hasActive = await service.hasActiveChallenge(TEST_ADDRESS);
        expect(hasActive).toBe(true);
      });
    });

    describe('consume', () => {
      it('should atomically retrieve and delete challenge', async () => {
        mockRedis.eval.mockResolvedValue(TEST_CHALLENGE);

        const result = await service.consume(TEST_ADDRESS);

        expect(result).toBe(TEST_CHALLENGE);
        expect(mockRedis.eval).toHaveBeenCalledWith(
          expect.any(String),
          1,
          `auth:nonce:${TEST_ADDRESS}`,
        );
      });

      it('should return null when no challenge exists', async () => {
        mockRedis.eval.mockResolvedValue(null);

        const result = await service.consume(TEST_ADDRESS);

        expect(result).toBeNull();
      });

      it('should fallback to memory when Redis fails', async () => {
        const redisError = new Error('Redis down');
        mockRedis.set.mockRejectedValue(redisError);
        mockRedis.eval.mockRejectedValue(redisError);
        await service.store(TEST_ADDRESS, TEST_CHALLENGE, TEST_NONCE);

        const result = await service.consume(TEST_ADDRESS);
        expect(result).toBe(TEST_CHALLENGE);
      });
    });

    describe('isNonceReplay', () => {
      it('should return true when nonce was already used', async () => {
        mockRedis.exists.mockResolvedValue(1);

        const result = await service.isNonceReplay(TEST_NONCE);

        expect(result).toBe(true);
        expect(mockRedis.exists).toHaveBeenCalledWith(`auth:nonce:used:${TEST_NONCE}`);
      });

      it('should return false when nonce was not used', async () => {
        mockRedis.exists.mockResolvedValue(0);

        const result = await service.isNonceReplay(TEST_NONCE);

        expect(result).toBe(false);
      });
    });

    describe('markNonceUsed', () => {
      it('should mark nonce as used in Redis and report first use', async () => {
        mockRedis.set.mockResolvedValue('OK');

        const firstUse = await service.markNonceUsed(TEST_NONCE);

        expect(firstUse).toBe(true);
        expect(mockRedis.set).toHaveBeenCalledWith(
          `auth:nonce:used:${TEST_NONCE}`,
          '1',
          'EX',
          300,
          'NX',
        );
      });

      it('should report replay when the nonce is already marked (NX fails)', async () => {
        mockRedis.set.mockResolvedValue(null);

        const firstUse = await service.markNonceUsed(TEST_NONCE);

        expect(firstUse).toBe(false);
      });
    });

    describe('hasActiveChallenge', () => {
      it('should return true when challenge exists', async () => {
        mockRedis.exists.mockResolvedValue(1);

        const result = await service.hasActiveChallenge(TEST_ADDRESS);

        expect(result).toBe(true);
      });

      it('should return false when no challenge exists', async () => {
        mockRedis.exists.mockResolvedValue(0);

        const result = await service.hasActiveChallenge(TEST_ADDRESS);

        expect(result).toBe(false);
      });
    });
  });

  describe('without Redis (fallback to memory)', () => {
    let memoryService: NonceStoreService;

    beforeEach(async () => {
      const module: TestingModule = await Test.createTestingModule({
        providers: [NonceStoreService, { provide: REDIS_CLIENT, useValue: null }],
      }).compile();

      memoryService = module.get<NonceStoreService>(NonceStoreService);
    });

    it('should store and retrieve challenge from memory', async () => {
      await memoryService.store(TEST_ADDRESS, TEST_CHALLENGE, TEST_NONCE);

      const result = await memoryService.consume(TEST_ADDRESS);
      expect(result).toBe(TEST_CHALLENGE);
    });

    it('should return null on second consume (single-use)', async () => {
      await memoryService.store(TEST_ADDRESS, TEST_CHALLENGE, TEST_NONCE);

      await memoryService.consume(TEST_ADDRESS);
      const result = await memoryService.consume(TEST_ADDRESS);
      expect(result).toBeNull();
    });

    it('should track used nonces for replay detection', async () => {
      await memoryService.markNonceUsed(TEST_NONCE);

      const isReplay = await memoryService.isNonceReplay(TEST_NONCE);
      expect(isReplay).toBe(true);
    });

    it('should return false for unknown nonces', async () => {
      const isReplay = await memoryService.isNonceReplay('unknown-nonce');
      expect(isReplay).toBe(false);
    });

    it('should not mark the nonce used as a side effect of store()', async () => {
      await memoryService.store(TEST_ADDRESS, TEST_CHALLENGE, TEST_NONCE);

      expect(await memoryService.isNonceReplay(TEST_NONCE)).toBe(false);
    });

    it('markNonceUsed reports first use, then replay on a second call', async () => {
      expect(await memoryService.markNonceUsed(TEST_NONCE)).toBe(true);
      expect(await memoryService.markNonceUsed(TEST_NONCE)).toBe(false);
    });

    it('should report active challenge', async () => {
      expect(await memoryService.hasActiveChallenge(TEST_ADDRESS)).toBe(false);

      await memoryService.store(TEST_ADDRESS, TEST_CHALLENGE, TEST_NONCE);

      expect(await memoryService.hasActiveChallenge(TEST_ADDRESS)).toBe(true);
    });

    it('should report no active challenge after consume', async () => {
      await memoryService.store(TEST_ADDRESS, TEST_CHALLENGE, TEST_NONCE);
      await memoryService.consume(TEST_ADDRESS);

      expect(await memoryService.hasActiveChallenge(TEST_ADDRESS)).toBe(false);
    });

    it('should detect expired challenges in memory', async () => {
      await memoryService.store(TEST_ADDRESS, TEST_CHALLENGE, TEST_NONCE);

      // Manually expire by advancing time
      const key = `auth:nonce:${TEST_ADDRESS}`;
      (memoryService as any).inMemoryChallenges.set(key, {
        challenge: TEST_CHALLENGE,
        expiresAt: Date.now() - 1000,
      });

      const result = await memoryService.consume(TEST_ADDRESS);
      expect(result).toBeNull();
    });
  });
});
