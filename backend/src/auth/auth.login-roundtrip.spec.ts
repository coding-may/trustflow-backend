import { Test, TestingModule } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import { UnauthorizedException } from '@nestjs/common';
import { Keypair } from '@stellar/stellar-sdk';
import { Redis } from 'ioredis';
import { AuthService } from './auth.service';
import { NonceStoreService } from './nonce-store.service';
import { REDIS_CLIENT } from '../common/redis/redis.module';

/**
 * Real challenge -> sign -> verify round trip against a real Stellar Keypair and the real
 * NonceStoreService (no mocks), covering the actual bug behind #431: `store()` used to mark
 * the nonce as "used" at issuance time, so a valid signature over a freshly issued challenge
 * was always rejected as a replay. Run once against the in-memory fallback, and again against
 * real Redis when REDIS_URL is available (CI provides one; see .github/workflows/backend-ci.yml).
 */
async function buildAuthService(redis: Redis | null): Promise<AuthService> {
  const module: TestingModule = await Test.createTestingModule({
    providers: [
      AuthService,
      NonceStoreService,
      { provide: REDIS_CLIENT, useValue: redis },
      {
        provide: JwtService,
        useValue: { sign: () => 'signed-jwt', verify: () => ({}) },
      },
    ],
  }).compile();

  return module.get(AuthService);
}

type RedisFactory = () => Redis | null;

const cases: Array<[string, RedisFactory]> = [
  ['in-memory fallback (no Redis)', () => null],
  ...(process.env.REDIS_URL
    ? ([['real Redis', () => new Redis(process.env.REDIS_URL!)]] as Array<[string, RedisFactory]>)
    : []),
];

describe.each(cases)('wallet login round trip (#431) — %s', (_label, makeRedis) => {
  let redis: Redis | null;
  let authService: AuthService;

  beforeEach(async () => {
    redis = makeRedis();
    if (redis) {
      const keys = await redis.keys('auth:nonce*');
      if (keys.length > 0) await redis.del(...keys);
    }
    authService = await buildAuthService(redis);
  });

  afterEach(async () => {
    if (redis) await redis.quit();
  });

  it('a valid signature over a freshly issued challenge is accepted', async () => {
    const keypair = Keypair.random();
    const challenge = await authService.generateChallenge(keypair.publicKey());

    const signature = keypair.sign(Buffer.from(challenge, 'utf-8')).toString('base64');

    const isValid = await authService.verifySignature(keypair.publicKey(), signature);
    expect(isValid).toBe(true);

    const token = authService.generateToken(keypair.publicKey());
    expect(token).toBe('signed-jwt');
  });

  it('reusing the same signed challenge a second time is rejected', async () => {
    const keypair = Keypair.random();
    const challenge = await authService.generateChallenge(keypair.publicKey());
    const signature = keypair.sign(Buffer.from(challenge, 'utf-8')).toString('base64');

    await expect(authService.verifySignature(keypair.publicKey(), signature)).resolves.toBe(true);

    await expect(authService.verifySignature(keypair.publicKey(), signature)).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('an expired challenge is rejected', async () => {
    const keypair = Keypair.random();
    const challenge = await authService.generateChallenge(keypair.publicKey());
    const signature = keypair.sign(Buffer.from(challenge, 'utf-8')).toString('base64');

    if (redis) {
      await redis.del(`auth:nonce:${keypair.publicKey()}`);
    } else {
      // Force-expire the in-memory challenge directly, mirroring how the Redis
      // branch above simulates TTL expiry without waiting out the real 60s window.
      const nonceStore = (authService as unknown as { nonceStore: NonceStoreService }).nonceStore;
      const key = `auth:nonce:${keypair.publicKey()}`;
      (
        nonceStore as unknown as {
          inMemoryChallenges: Map<string, { challenge: string; expiresAt: number }>;
        }
      ).inMemoryChallenges.set(key, { challenge, expiresAt: Date.now() - 1000 });
    }

    await expect(authService.verifySignature(keypair.publicKey(), signature)).rejects.toThrow(
      UnauthorizedException,
    );
  });
});
