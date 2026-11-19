import { Test, TestingModule } from '@nestjs/testing';
import { ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { DeliverableService } from './deliverable.service';
import { IpfsPinningService } from '../ipfs-pinning/ipfs-pinning.service';
import { GigService } from '../gig/gig.service';
import { Gig, GigStatus } from '../gig/gig.entity';
import { REDIS_CLIENT } from '../common/redis/redis.module';
import { UploadDeliverableDto } from './deliverable.dto';
import { DeliverableStatus } from './deliverable.entity';

const FREELANCER = 'G' + 'A'.repeat(55);
const OTHER_WALLET = 'G' + 'B'.repeat(55);

function makeGig(overrides: Partial<Gig> = {}): Gig {
  return {
    id: 'gig-1',
    creator: 'G' + 'C'.repeat(55),
    title: 'Audit report',
    budgetXLM: '100',
    status: GigStatus.ACCEPTED,
    createdAt: new Date().toISOString(),
    respondBy: new Date().toISOString(),
    acceptedBy: FREELANCER,
    version: 1,
    ...overrides,
  };
}

describe('DeliverableService', () => {
  let service: DeliverableService;

  const mockIpfsPinningService = {
    pinContent: jest.fn(),
  };

  const mockGigService = {
    findById: jest.fn(),
  };

  const mockRedis = null;

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DeliverableService,
        { provide: IpfsPinningService, useValue: mockIpfsPinningService },
        { provide: GigService, useValue: mockGigService },
        { provide: REDIS_CLIENT, useValue: mockRedis },
      ],
    }).compile();

    service = module.get<DeliverableService>(DeliverableService);
    mockGigService.findById.mockImplementation(async (id: string) => makeGig({ id }));
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('upload', () => {
    const dto: UploadDeliverableDto = {
      gigId: 'gig-1',
      freelancer: FREELANCER,
      content: Buffer.from('test file').toString('base64'),
      filename: 'report.pdf',
    };

    it('pins content to IPFS and stores the deliverable', async () => {
      mockIpfsPinningService.pinContent.mockResolvedValue({
        cid: 'bafytest123',
        size: 9,
      });

      const result = await service.upload(dto, FREELANCER);

      expect(result.gigId).toBe('gig-1');
      expect(result.cid).toBe('bafytest123');
      expect(result.filename).toBe('report.pdf');
      expect(result.status).toBe(DeliverableStatus.PINNED);
      expect(mockIpfsPinningService.pinContent).toHaveBeenCalledWith({
        content: dto.content,
        filename: dto.filename,
      });
    });

    it('can retrieve uploaded deliverable by ID', async () => {
      mockIpfsPinningService.pinContent.mockResolvedValue({
        cid: 'bafytest456',
        size: 20,
      });

      const created = await service.upload(dto, FREELANCER);
      const found = await service.findById(created.id);

      expect(found.id).toBe(created.id);
      expect(found.cid).toBe('bafytest456');
    });

    it('returns deliverables filtered by gig ID with pagination', async () => {
      mockIpfsPinningService.pinContent.mockResolvedValue({ cid: 'c1', size: 1 });

      await service.upload({ ...dto, gigId: 'gig-1' }, FREELANCER);
      await service.upload({ ...dto, gigId: 'gig-2' }, FREELANCER);
      const gig1Deliverables = await service.findByGig('gig-1');

      expect(gig1Deliverables.items).toHaveLength(1);
      expect(gig1Deliverables.items[0].gigId).toBe('gig-1');
      expect(gig1Deliverables.total).toBe(1);
      expect(gig1Deliverables.page).toBe(1);
      expect(gig1Deliverables.limit).toBe(20);
    });

    it('paginates deliverables when page and limit are specified', async () => {
      mockIpfsPinningService.pinContent.mockResolvedValue({ cid: 'c1', size: 1 });

      for (let i = 1; i <= 5; i++) {
        await service.upload({ ...dto, gigId: 'gig-paginated', filename: `report-${i}.pdf` }, FREELANCER);
      }

      const page1 = await service.findByGig('gig-paginated', { page: 1, limit: 2 });
      expect(page1.items).toHaveLength(2);
      expect(page1.total).toBe(5);
      expect(page1.page).toBe(1);

      const page2 = await service.findByGig('gig-paginated', { page: 2, limit: 2 });
      expect(page2.items).toHaveLength(2);
      expect(page2.total).toBe(5);
      expect(page2.page).toBe(2);

      const page3 = await service.findByGig('gig-paginated', { page: 3, limit: 2 });
      expect(page3.items).toHaveLength(1);
      expect(page3.total).toBe(5);
      expect(page3.page).toBe(3);
    });

    describe('authorization and gig verification', () => {
      async function expectRejectedWithoutPinning(
        promise: Promise<unknown>,
        error: new (...args: never[]) => Error,
      ) {
        await expect(promise).rejects.toBeInstanceOf(error);
        expect(mockIpfsPinningService.pinContent).not.toHaveBeenCalled();
        const empty = await service.findByGig(dto.gigId);
        expect(empty.items).toEqual([]);
        expect(empty.total).toBe(0);
      }

      it('looks the gig up by the requested gigId', async () => {
        mockIpfsPinningService.pinContent.mockResolvedValue({ cid: 'c', size: 1 });

        await service.upload(dto, FREELANCER);

        expect(mockGigService.findById).toHaveBeenCalledWith('gig-1');
      });

      it('rejects with 404 when the gig does not exist', async () => {
        mockGigService.findById.mockRejectedValue(new NotFoundException('Gig gig-1 not found'));

        await expectRejectedWithoutPinning(service.upload(dto, FREELANCER), NotFoundException);
      });

      it.each([GigStatus.OPEN, GigStatus.EXPIRED, GigStatus.CANCELLED])(
        'rejects with 409 when the gig is %s',
        async status => {
          mockGigService.findById.mockResolvedValue(makeGig({ status, acceptedBy: undefined }));

          await expectRejectedWithoutPinning(service.upload(dto, FREELANCER), ConflictException);
        },
      );

      it('rejects with 403 when the body names a freelancer who did not accept the gig', async () => {
        await expectRejectedWithoutPinning(
          service.upload({ ...dto, freelancer: OTHER_WALLET }, FREELANCER),
          ForbiddenException,
        );
      });

      it('rejects with 403 when the authenticated wallet is not the accepted freelancer', async () => {
        // Body impersonates the real freelancer, but the JWT belongs to someone else.
        await expectRejectedWithoutPinning(service.upload(dto, OTHER_WALLET), ForbiddenException);
      });

      it('rejects with 403 when neither the body nor the token match the accepted freelancer', async () => {
        await expectRejectedWithoutPinning(
          service.upload({ ...dto, freelancer: OTHER_WALLET }, OTHER_WALLET),
          ForbiddenException,
        );
      });

      it('does not reveal who accepted the gig in the error message', async () => {
        const error = await service.upload(dto, OTHER_WALLET).catch(e => e as Error);

        expect(error).toBeInstanceOf(ForbiddenException);
        expect((error as Error).message).not.toContain(FREELANCER);
      });
    });
  });
});
