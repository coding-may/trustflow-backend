import {
  ExecutionContext,
  ForbiddenException,
  INestApplication,
  VersioningType,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { ReputationController } from './reputation.controller';
import { ReputationService } from './reputation.service';
import { REPUTATION_LEADERBOARD_DEFAULT_LIMIT } from './reputation.types';
import { JwtAuthGuard } from '../auth/auth.guard';
import { validateEnv, resetEnvConfig } from '../config/env.config';

// getScoreBreakdown() reads config.ADMIN_ADDRESSES, which requires validateEnv() to have run
// first — normally done once in main.ts.
validateEnv();

function reqAs(address: string) {
  return { user: { address, sub: address } };
}

describe('ReputationController', () => {
  let controller: ReputationController;

  const mockService = {
    getScore: jest.fn(),
    getLeaderboard: jest.fn(),
    getScoreBreakdown: jest.fn(),
  };

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      controllers: [ReputationController],
      providers: [{ provide: ReputationService, useValue: mockService }],
    }).compile();

    controller = module.get<ReputationController>(ReputationController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  describe('getScore', () => {
    it('delegates to the service with the address', () => {
      mockService.getScore.mockReturnValue({ address: 'GABC', score: 12.5 });

      const result = controller.getScore('GABC');

      expect(mockService.getScore).toHaveBeenCalledWith('GABC');
      expect(result).toEqual({ address: 'GABC', score: 12.5 });
    });
  });

  describe('getLeaderboard', () => {
    it('uses the default limit when none is supplied', () => {
      mockService.getLeaderboard.mockReturnValue([]);

      controller.getLeaderboard(undefined);

      expect(mockService.getLeaderboard).toHaveBeenCalledWith(REPUTATION_LEADERBOARD_DEFAULT_LIMIT);
    });

    it('parses a valid limit query param', () => {
      mockService.getLeaderboard.mockReturnValue([]);

      controller.getLeaderboard('5');

      expect(mockService.getLeaderboard).toHaveBeenCalledWith(5);
    });

    it('falls back to the default limit for an invalid limit param', () => {
      mockService.getLeaderboard.mockReturnValue([]);

      controller.getLeaderboard('not-a-number');

      expect(mockService.getLeaderboard).toHaveBeenCalledWith(REPUTATION_LEADERBOARD_DEFAULT_LIMIT);
    });

    it('falls back to the default limit for a non-positive limit param', () => {
      mockService.getLeaderboard.mockReturnValue([]);

      controller.getLeaderboard('0');

      expect(mockService.getLeaderboard).toHaveBeenCalledWith(REPUTATION_LEADERBOARD_DEFAULT_LIMIT);
    });
  });

  describe('getScoreBreakdown (#989)', () => {
    const originalAdminAddresses = process.env.ADMIN_ADDRESSES;

    function setAdminAddresses(value: string | undefined) {
      if (value === undefined) delete process.env.ADMIN_ADDRESSES;
      else process.env.ADMIN_ADDRESSES = value;
      resetEnvConfig();
      validateEnv();
    }

    afterEach(() => {
      setAdminAddresses(originalAdminAddresses);
    });

    it('allows the address owner and delegates to the service', () => {
      setAdminAddresses(undefined);
      mockService.getScoreBreakdown.mockReturnValue({ address: 'GABC', events: [] });

      const result = controller.getScoreBreakdown('GABC', reqAs('GABC'));

      expect(mockService.getScoreBreakdown).toHaveBeenCalledWith('GABC');
      expect(result).toEqual({ address: 'GABC', events: [] });
    });

    it('allows an admin viewing a different address', () => {
      setAdminAddresses('GADMIN');
      mockService.getScoreBreakdown.mockReturnValue({ address: 'GABC', events: [] });

      const result = controller.getScoreBreakdown('GABC', reqAs('GADMIN'));

      expect(mockService.getScoreBreakdown).toHaveBeenCalledWith('GABC');
      expect(result).toEqual({ address: 'GABC', events: [] });
    });

    it('rejects a caller who is neither the owner nor an admin', () => {
      setAdminAddresses('GADMIN');

      expect(() => controller.getScoreBreakdown('GABC', reqAs('GSTRANGER'))).toThrow(
        ForbiddenException,
      );
      expect(mockService.getScoreBreakdown).not.toHaveBeenCalled();
    });
  });
});

describe('ReputationController Supertest integration', () => {
  let app: INestApplication;
  let requestUserAddress: string;

  const mockService = {
    getScore: jest.fn(),
    getLeaderboard: jest.fn(),
    getScoreBreakdown: jest.fn(),
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    requestUserAddress = 'GABC';

    const module: TestingModule = await Test.createTestingModule({
      controllers: [ReputationController],
      providers: [{ provide: ReputationService, useValue: mockService }],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({
        canActivate: (context: ExecutionContext) => {
          const request = context.switchToHttp().getRequest<{ user?: unknown }>();
          request.user = { address: requestUserAddress, sub: 'x' };
          return true;
        },
      })
      .compile();

    app = module.createNestApplication();
    app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  it('GET /reputation/leaderboard returns the ranked list', async () => {
    mockService.getLeaderboard.mockReturnValue([
      { address: 'GHIGH', score: 90 },
      { address: 'GLOW', score: 10 },
    ]);

    const response = await request(app.getHttpServer()).get('/v1/reputation/leaderboard').expect(200);

    expect(response.body).toEqual([
      { address: 'GHIGH', score: 90 },
      { address: 'GLOW', score: 10 },
    ]);
    expect(mockService.getLeaderboard).toHaveBeenCalledWith(REPUTATION_LEADERBOARD_DEFAULT_LIMIT);
  });

  it('GET /reputation/leaderboard?limit=1 forwards the parsed limit', async () => {
    mockService.getLeaderboard.mockReturnValue([{ address: 'GHIGH', score: 90 }]);

    await request(app.getHttpServer()).get('/v1/reputation/leaderboard?limit=1').expect(200);

    expect(mockService.getLeaderboard).toHaveBeenCalledWith(1);
  });

  it('GET /reputation/:address returns the score view', async () => {
    mockService.getScore.mockReturnValue({
      address: 'GABC',
      score: 42.5,
      eventCount: 3,
      distinctCounterparties: 2,
      recentEvents: [],
      lastUpdatedAt: '2026-01-01T00:00:00.000Z',
    });

    const response = await request(app.getHttpServer()).get('/v1/reputation/GABC').expect(200);

    expect(response.body).toMatchObject({ address: 'GABC', score: 42.5 });
    expect(mockService.getScore).toHaveBeenCalledWith('GABC');
  });

  it('routes /reputation/leaderboard to the leaderboard handler, not :address', async () => {
    mockService.getLeaderboard.mockReturnValue([]);

    await request(app.getHttpServer()).get('/v1/reputation/leaderboard').expect(200);

    expect(mockService.getScore).not.toHaveBeenCalled();
    expect(mockService.getLeaderboard).toHaveBeenCalled();
  });

  describe('GET /reputation/:address/breakdown (#989)', () => {
    it('returns the breakdown for the authenticated owner', async () => {
      requestUserAddress = 'GABC';
      mockService.getScoreBreakdown.mockReturnValue({
        address: 'GABC',
        score: 12.5,
        eventCount: 1,
        lastUpdatedAt: '2026-01-01T00:00:00.000Z',
        events: [],
      });

      const response = await request(app.getHttpServer())
        .get('/v1/reputation/GABC/breakdown')
        .expect(200);

      expect(response.body).toMatchObject({ address: 'GABC', score: 12.5 });
      expect(mockService.getScoreBreakdown).toHaveBeenCalledWith('GABC');
    });

    it('returns 403 for an authenticated caller who is not the owner', async () => {
      requestUserAddress = 'GSTRANGER';

      await request(app.getHttpServer()).get('/v1/reputation/GABC/breakdown').expect(403);

      expect(mockService.getScoreBreakdown).not.toHaveBeenCalled();
    });
  });
});
