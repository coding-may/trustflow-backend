import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import { DeliverableController } from './deliverable.controller';
import { DeliverableService } from './deliverable.service';
import { JwtAuthGuard } from '../auth/auth.guard';

const FREELANCER = 'G' + 'A'.repeat(55);
const OTHER_WALLET = 'G' + 'B'.repeat(55);

function makeReq(address = FREELANCER) {
  return { user: { address, sub: address } };
}

const VALID_BODY = {
  gigId: 'gig-1',
  freelancer: FREELANCER,
  content: Buffer.from('audit findings').toString('base64'),
  filename: 'audit.pdf',
};

describe('DeliverableController', () => {
  let controller: DeliverableController;
  const mockService = { upload: jest.fn(), findById: jest.fn(), findByGig: jest.fn() };

  beforeEach(async () => {
    jest.clearAllMocks();
    mockService.upload.mockResolvedValue({ id: 'del-1' });

    const module: TestingModule = await Test.createTestingModule({
      controllers: [DeliverableController],
      providers: [
        { provide: DeliverableService, useValue: mockService },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = module.get(DeliverableController);
  });

  describe('review() (#923)', () => {
    it('passes review payload and authenticated wallet to service', async () => {
      mockService.review = jest.fn().mockResolvedValue({ id: 'del-1', status: 'approved' });
      const result = await controller.review('del-1', { status: 'APPROVED' }, makeReq() as any);
      expect(result).toEqual({ id: 'del-1', status: 'approved' });
      expect(mockService.review).toHaveBeenCalledWith('del-1', { status: 'APPROVED' }, FREELANCER);
    });

    it('propagates 409 ConflictException when already finalized', async () => {
      const { ConflictException } = jest.requireActual('@nestjs/common');
      mockService.review = jest.fn().mockRejectedValue(new ConflictException('already finalized'));
      await expect(
        controller.review('del-1', { status: 'APPROVED' }, makeReq() as any),
      ).rejects.toThrow(ConflictException);
    });
  });

  describe('upload()', () => {
    it('passes the validated body and the authenticated wallet to the service', async () => {
      const result = await controller.upload(VALID_BODY, makeReq() as any);

      expect(result).toEqual({ id: 'del-1' });
      expect(mockService.upload).toHaveBeenCalledWith(VALID_BODY, FREELANCER);
    });

    it('takes the requester from the JWT, not from the body', async () => {
      await controller.upload(VALID_BODY, makeReq(OTHER_WALLET) as any);

      expect(mockService.upload).toHaveBeenCalledWith(VALID_BODY, OTHER_WALLET);
    });

    it('propagates the service rejections unchanged', async () => {
      const { ForbiddenException } = jest.requireActual('@nestjs/common');
      mockService.upload.mockRejectedValue(new ForbiddenException('nope'));

      await expect(controller.upload(VALID_BODY, makeReq() as any)).rejects.toThrow(
        ForbiddenException,
      );
    });

    it.each([
      ['invalid base64 characters', 'this is not base64!'],
      ['a length that is not a multiple of 4', 'QUJDR'],
      ['content over the size limit', 'A'.repeat(14_316_560 + 4)],
    ])('answers 400 for %s without calling the service', async (_name, content) => {
      await expect(
        controller.upload({ ...VALID_BODY, content }, makeReq() as any),
      ).rejects.toThrow(BadRequestException);
      expect(mockService.upload).not.toHaveBeenCalled();
    });

    it('answers 400 for a malformed freelancer address', async () => {
      await expect(
        controller.upload({ ...VALID_BODY, freelancer: 'nope' }, makeReq() as any),
      ).rejects.toThrow(BadRequestException);
      expect(mockService.upload).not.toHaveBeenCalled();
    });
  });

  describe('findByGig()', () => {
    it('delegates to the service with gigId and parsed pagination query', async () => {
      mockService.findByGig.mockResolvedValue({
        items: [{ id: 'del-1', gigId: 'gig-1' }],
        total: 1,
        page: 2,
        limit: 10,
      });

      const result = await controller.findByGig('gig-1', 2, 10);

      expect(mockService.findByGig).toHaveBeenCalledWith('gig-1', { page: 2, limit: 10 });
      expect(result).toEqual({
        items: [{ id: 'del-1', gigId: 'gig-1' }],
        total: 1,
        page: 2,
        limit: 10,
      });
    });

    it('handles undefined pagination parameters with default query shape', async () => {
      mockService.findByGig.mockResolvedValue({
        items: [],
        total: 0,
        page: 1,
        limit: 20,
      });

      await controller.findByGig('gig-1');

      expect(mockService.findByGig).toHaveBeenCalledWith('gig-1', {
        page: undefined,
        limit: undefined,
      });
    });
  });
});
