import { Test, TestingModule } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import { UnauthorizedException } from '@nestjs/common';
import { Keypair } from '@stellar/stellar-sdk';
import { AuthService } from './auth.service';
import { NonceStoreService } from './nonce-store.service';

describe('AuthService', () => {
  let service: AuthService;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mockNonceStore: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mockJwtService: any;

  const TEST_ADDRESS = 'GABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890ABCDEFGHIJKLMNOP';
  const TEST_SIGNATURE = 'SGVsbG8gV29ybGQh';

  beforeEach(async () => {
    mockNonceStore = {
      store: jest.fn(),
      consume: jest.fn(),
      markNonceUsed: jest.fn(),
      hasActiveChallenge: jest.fn(),
    };

    mockJwtService = {
      sign: jest.fn().mockReturnValue('mock-jwt-token'),
      verify: jest.fn().mockReturnValue({ address: TEST_ADDRESS, sub: TEST_ADDRESS }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: NonceStoreService, useValue: mockNonceStore },
        { provide: JwtService, useValue: mockJwtService },
      ],
    }).compile();

    service = module.get<AuthService>(AuthService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('generateChallenge', () => {
    it('should generate a challenge and store it', async () => {
      mockNonceStore.store.mockResolvedValue(undefined);

      const challenge = await service.generateChallenge(TEST_ADDRESS);

      expect(challenge).toMatch(/^Sign this message to authenticate with TrustFlow: [a-f0-9]{64}$/);
      expect(mockNonceStore.store).toHaveBeenCalledWith(
        TEST_ADDRESS,
        challenge,
        expect.stringMatching(/^[a-f0-9]{64}$/),
      );
    });

    it('should generate unique challenges', async () => {
      mockNonceStore.store.mockResolvedValue(undefined);

      const challenge1 = await service.generateChallenge(TEST_ADDRESS);
      const challenge2 = await service.generateChallenge(TEST_ADDRESS);

      expect(challenge1).not.toBe(challenge2);
    });
  });

  describe('verifySignature', () => {
    it('should throw when challenge not found', async () => {
      mockNonceStore.consume.mockResolvedValue(null);

      await expect(service.verifySignature(TEST_ADDRESS, TEST_SIGNATURE)).rejects.toThrow(
        UnauthorizedException,
      );
      await expect(service.verifySignature(TEST_ADDRESS, TEST_SIGNATURE)).rejects.toThrow(
        'Challenge not found, expired, or already consumed',
      );
    });

    // #431: a fresh, never-used nonce must be accepted — store() no longer premarks it
    // used, so a valid signature over a just-issued challenge succeeds and marks the
    // nonce used via the atomic markNonceUsed() check-and-set (not a separate pre-check).
    it('returns true for a valid signature and marks the nonce used exactly once', async () => {
      const keypair = Keypair.random();
      const nonce = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2';
      const challenge = `Sign this message to authenticate with TrustFlow: ${nonce}`;
      const signature = keypair.sign(Buffer.from(challenge, 'utf-8')).toString('base64');

      mockNonceStore.consume.mockResolvedValue(challenge);
      mockNonceStore.markNonceUsed.mockResolvedValue(true);

      const isValid = await service.verifySignature(keypair.publicKey(), signature);

      expect(isValid).toBe(true);
      expect(mockNonceStore.markNonceUsed).toHaveBeenCalledWith(nonce);
    });

    it('should throw when the nonce was already marked used (replay)', async () => {
      const keypair = Keypair.random();
      const nonce = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2';
      const challenge = `Sign this message to authenticate with TrustFlow: ${nonce}`;
      const signature = keypair.sign(Buffer.from(challenge, 'utf-8')).toString('base64');

      mockNonceStore.consume.mockResolvedValue(challenge);
      mockNonceStore.markNonceUsed.mockResolvedValue(false);

      await expect(service.verifySignature(keypair.publicKey(), signature)).rejects.toThrow(
        UnauthorizedException,
      );
      await expect(service.verifySignature(keypair.publicKey(), signature)).rejects.toThrow(
        'Challenge already used',
      );
    });
  });

  describe('generateToken', () => {
    it('should generate a JWT token', () => {
      const token = service.generateToken(TEST_ADDRESS);

      expect(token).toBe('mock-jwt-token');
      expect(mockJwtService.sign).toHaveBeenCalledWith({
        address: TEST_ADDRESS,
        sub: TEST_ADDRESS,
      });
    });
  });

  describe('validateToken', () => {
    it('should validate a valid token', () => {
      const result = service.validateToken('valid-token');

      expect(result).toEqual({ address: TEST_ADDRESS, sub: TEST_ADDRESS });
      expect(mockJwtService.verify).toHaveBeenCalledWith('valid-token');
    });

    it('should throw on invalid token', () => {
      mockJwtService.verify.mockImplementation(() => {
        throw new Error('jwt malformed');
      });

      expect(() => service.validateToken('bad-token')).toThrow(UnauthorizedException);
    });
  });
});
