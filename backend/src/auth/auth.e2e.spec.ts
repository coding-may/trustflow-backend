import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { Keypair } from '@stellar/stellar-sdk';
import { AuthModule } from './auth.module';
import { AuthService } from './auth.service';
import { RedisModule } from '../common/redis/redis.module';
import { validateEnv } from '../config/env.config';

// AuthModule's JwtModule.registerAsync() reads config.JWT_SECRET at instantiation, which
// requires validateEnv() to have run first — normally done once in main.ts. This test was
// never actually collected by Jest before (wrong filename suffix, see #431/#397), so this
// gap went unnoticed until the rename made it run.
validateEnv();

describe('Auth (E2E)', () => {
  let app: INestApplication;
  let authService: AuthService;

  // POST /auth/verify validates `address` against VerifyDto's `/^G[A-Z0-9]{55}$/` (56 chars
  // total); the previous hardcoded literal here was only 53 chars, so every /auth/verify
  // request in this file 400'd on DTO validation before ever reaching the mocked service —
  // invisible until the rename made this suite actually run (see #431/#397).
  const TEST_ADDRESS = Keypair.random().publicKey();

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      // NonceStoreService (used by AuthService) injects REDIS_CLIENT, which RedisModule
      // provides as a @Global() binding in the real app (imported once at the root). This
      // standalone test needs it imported explicitly since AuthModule alone doesn't pull
      // it in. No REDIS_URL is set here, so it resolves to `null` — the in-memory fallback.
      imports: [AuthModule, RedisModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }),
    );
    await app.init();

    authService = moduleFixture.get<AuthService>(AuthService);
  });

  afterAll(async () => {
    await app.close();
  });

  describe('GET /auth/challenge', () => {
    it('returns a challenge string for a valid address', async () => {
      const res = await request(app.getHttpServer())
        .get('/auth/challenge')
        .query({ address: TEST_ADDRESS })
        .expect(200);

      expect(res.body).toHaveProperty('challenge');
      expect(typeof res.body.challenge).toBe('string');
      expect(res.body.challenge).toContain('Sign this message to authenticate with TrustFlow:');
    });

    it('returns 400 or error when address is missing', async () => {
      const res = await request(app.getHttpServer()).get('/auth/challenge').expect(500);

      // The controller throws a raw Error('address required') which NestJS turns into 500
      expect(res.status).toBe(500);
    });
  });

  describe('POST /auth/verify', () => {
    it('returns a JWT token for a valid signature', async () => {
      // First get a challenge
      const challengeRes = await request(app.getHttpServer())
        .get('/auth/challenge')
        .query({ address: TEST_ADDRESS })
        .expect(200);

      const challenge = challengeRes.body.challenge;

      // Mock the signature verification to return true
      jest.spyOn(authService, 'verifySignature').mockResolvedValueOnce(true);
      jest.spyOn(authService, 'generateToken').mockReturnValueOnce('mock-e2e-jwt-token');

      const verifyRes = await request(app.getHttpServer())
        .post('/auth/verify')
        .send({ address: TEST_ADDRESS, signature: 'SGVsbG8gV29ybGQh' })
        .expect(200);

      expect(verifyRes.body).toHaveProperty('token');
      expect(verifyRes.body.token).toBe('mock-e2e-jwt-token');

      jest.restoreAllMocks();
    });

    it('returns 500 for an invalid signature', async () => {
      // Get a challenge first
      await request(app.getHttpServer())
        .get('/auth/challenge')
        .query({ address: TEST_ADDRESS })
        .expect(200);

      // Mock verifySignature to return false
      jest.spyOn(authService, 'verifySignature').mockResolvedValueOnce(false);

      const res = await request(app.getHttpServer())
        .post('/auth/verify')
        .send({ address: TEST_ADDRESS, signature: 'invalid-sig' })
        .expect(500);

      jest.restoreAllMocks();
    });

    it('rejects request with missing address field', async () => {
      const res = await request(app.getHttpServer())
        .post('/auth/verify')
        .send({ signature: 'SGVsbG8gV29ybGQh' })
        .expect(400);

      expect(res.body.message).toBeDefined();
    });

    it('rejects request with missing signature field', async () => {
      const res = await request(app.getHttpServer())
        .post('/auth/verify')
        .send({ address: TEST_ADDRESS })
        .expect(400);

      expect(res.body.message).toBeDefined();
    });
  });

  describe('full auth flow', () => {
    it('challenge → verify → token works end-to-end', async () => {
      // Step 1: Get challenge
      const challengeRes = await request(app.getHttpServer())
        .get('/auth/challenge')
        .query({ address: TEST_ADDRESS })
        .expect(200);

      const challenge = challengeRes.body.challenge;
      expect(challenge).toBeTruthy();

      // Step 2: Verify signature and get token
      jest.spyOn(authService, 'verifySignature').mockResolvedValueOnce(true);
      jest.spyOn(authService, 'generateToken').mockReturnValueOnce('flow-jwt-token');

      const verifyRes = await request(app.getHttpServer())
        .post('/auth/verify')
        .send({ address: TEST_ADDRESS, signature: 'dGVzdC1zaWduYXR1cmU=' })
        .expect(200);

      expect(verifyRes.body.token).toBe('flow-jwt-token');

      jest.restoreAllMocks();
    });
  });
});
