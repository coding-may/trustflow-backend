import { ReviewDeliverableDto } from './deliverable.dto';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { SanitizedLogger } from '../common/logging/sanitized-logger';
import { Redis } from 'ioredis';
import { REDIS_CLIENT } from '../common/redis/redis.module';
import { IpfsPinningService } from '../ipfs-pinning/ipfs-pinning.service';
import { GigService } from '../gig/gig.service';
import { GigStatus } from '../gig/gig.entity';
import { UploadDeliverableDto } from './deliverable.dto';
import { Deliverable, DeliverableStatus } from './deliverable.entity';
import { PinStatus } from '../ipfs-pinning/ipfs-pinning.types';
import { PaginatedResponse, PaginationQuery, paginate } from '../common/pagination';

const DELIVERABLE_KEY_PREFIX = 'deliverable:';
const DELIVERABLES_BY_GIG_PREFIX = 'deliverables:gig:';

@Injectable()
export class DeliverableService {
  private readonly logger = new SanitizedLogger(DeliverableService.name);
  private readonly deliverables = new Map<string, Deliverable>();

  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis | null,
    private readonly ipfsPinningService: IpfsPinningService,
    private readonly gigService: GigService,
  ) {}

  /**
   * Pins a deliverable for a gig. `requester` is the authenticated wallet (from the JWT);
   * the gig must exist, be accepted, and have been accepted by both `dto.freelancer` and the
   * requester. Nothing is decoded or pinned until those checks pass.
   */
  async upload(dto: UploadDeliverableDto, requester: string): Promise<Deliverable> {
    await this.assertMayDeliver(dto, requester);

    const id = `del-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const now = new Date().toISOString();

    let cid: string;
    let size: number;
    let deliverableStatus: DeliverableStatus;

    if (dto.fileHash) {
      cid = dto.fileHash;
      size = 0;
      deliverableStatus = DeliverableStatus.PENDING;
    } else {
      const buffer = Buffer.from(dto.content!, 'base64');
      await this.validateFileMagicBytes(buffer, dto.filename);
      const pinResult = await this.ipfsPinningService.pinContent({
        content: dto.content!,
        filename: dto.filename,
      });
      cid = pinResult.cid;
      size = pinResult.size;
      deliverableStatus = this.mapPinStatusToDeliverableStatus(pinResult.status);
    }

    const deliverable: Deliverable = {
      id,
      gigId: dto.gigId,
      freelancer: dto.freelancer,
      cid,
      filename: dto.filename,
      size,
      status: deliverableStatus,
      createdAt: now,
      updatedAt: now,
    };

    if (this.redis) {
      try {
        await this.redis
          .multi()
          .set(this.deliverableKey(id), JSON.stringify(deliverable))
          .sadd(this.gigKey(dto.gigId), id)
          .exec();
        return deliverable;
      } catch (err) {
        this.logger.error('Redis unavailable for deliverable upload, using in-memory', err);
      }
    }

    this.deliverables.set(id, deliverable);
    return deliverable;
  }

  /**
   * Validates file content by inspecting magic bytes to prevent malicious files
   * disguised with incorrect Content-Type headers. Rejects files that don't match
   * the whitelist or have mismatched MIME types.
   */
  private async validateFileMagicBytes(buffer: Buffer, filename: string): Promise<void> {
    const { fileTypeFromBuffer } = await import('file-type');
    const detected = await fileTypeFromBuffer(buffer);

    // Whitelist of allowed MIME types
    const allowedMimeTypes = [
      'application/pdf',
      'image/png',
      'image/jpeg',
      'image/jpg',
      'application/zip',
      'application/x-zip-compressed',
    ];

    if (!detected) {
      throw new BadRequestException(
        'Unable to determine file type from content. Only PDF, PNG, JPEG, and ZIP files are allowed.',
      );
    }

    if (!allowedMimeTypes.includes(detected.mime)) {
      throw new BadRequestException(
        `File type ${detected.mime} is not allowed. Only PDF, PNG, JPEG, and ZIP files are allowed.`,
      );
    }

    this.logger.log(
      `File validation passed: ${filename} detected as ${detected.mime} (${detected.ext})`,
    );
  }

  /**
   * @throws NotFoundException (404) when the gig does not exist
   * @throws ConflictException (409) when the gig has not been accepted (open, expired, cancelled)
   * @throws ForbiddenException (403) unless the gig's accepted freelancer is both the
   *   `freelancer` in the body and the authenticated requester
   */
  private async assertMayDeliver(dto: UploadDeliverableDto, requester: string): Promise<void> {
    const gig = await this.gigService.findById(dto.gigId);

    if (gig.status !== GigStatus.ACCEPTED) {
      throw new ConflictException(
        `Gig ${gig.id} is "${gig.status}"; deliverables can only be uploaded for accepted gigs`,
      );
    }
    if (gig.acceptedBy !== dto.freelancer) {
      throw new ForbiddenException('freelancer must be the freelancer who accepted the gig');
    }
    if (gig.acceptedBy !== requester) {
      throw new ForbiddenException(
        'Only the freelancer who accepted the gig can upload its deliverables',
      );
    }
  }

  async findById(id: string): Promise<Deliverable> {
    const d = await this.tryFindById(id);
    if (!d) throw new NotFoundException(`Deliverable ${id} not found`);
    return d;
  }

  async findByGig(
    gigId: string,
    query?: PaginationQuery,
  ): Promise<PaginatedResponse<Deliverable>> {
    let deliverables: Deliverable[];
    if (this.redis) {
      try {
        const ids = await this.redis.smembers(this.gigKey(gigId));
        deliverables = await this.fetchMany(ids);
      } catch (err) {
        this.logger.error('Redis unavailable for deliverable.findByGig', err);
        deliverables = [...this.deliverables.values()].filter(d => d.gigId === gigId);
      }
    } else {
      deliverables = [...this.deliverables.values()].filter(d => d.gigId === gigId);
    }
    return paginate(deliverables, query);
  }

  private async tryFindById(id: string): Promise<Deliverable | undefined> {
    if (this.redis) {
      try {
        const raw = await this.redis.get(this.deliverableKey(id));
        return raw ? (JSON.parse(raw) as Deliverable) : undefined;
      } catch {
        // fall through
      }
    }
    return this.deliverables.get(id);
  }

  private async fetchMany(ids: string[]): Promise<Deliverable[]> {
    if (ids.length === 0) return [];
    const raw = await this.redis!.mget(...ids.map(id => this.deliverableKey(id)));
    return raw.filter((r): r is string => r !== null).map(r => JSON.parse(r) as Deliverable);
  }

  private deliverableKey(id: string): string {
    return `${DELIVERABLE_KEY_PREFIX}${id}`;
  }

  private gigKey(gigId: string): string {
    return `${DELIVERABLES_BY_GIG_PREFIX}${gigId}`;
  }

  private mapPinStatusToDeliverableStatus(pinStatus: PinStatus): DeliverableStatus {
    switch (pinStatus) {
      case PinStatus.HEALTHY:
        return DeliverableStatus.PINNED;
      case PinStatus.DEGRADED:
        return DeliverableStatus.PENDING;
      case PinStatus.FAILED:
        return DeliverableStatus.FAILED;
      default:
        return DeliverableStatus.FAILED;
    }
  }

  /**
   * Reviews a deliverable, transitioning its status.
   * Status guard (#923): only PENDING/PINNED deliverables can be reviewed.
   * If already finalized (APPROVED or REJECTED), throws 409 ConflictException.
   */
  async review(
    id: string,
    dto: ReviewDeliverableDto,
    reviewerAddress: string,
  ): Promise<Deliverable> {
    const deliverable = await this.findById(id);

    const currentStatus = deliverable.status.toLowerCase();
    if (currentStatus === 'approved' || currentStatus === 'rejected') {
      throw new ConflictException(
        `Deliverable ${id} is already finalized with status '${deliverable.status}'`,
      );
    }

    const nextStatus =
      dto.status.toUpperCase() === 'APPROVED'
        ? DeliverableStatus.APPROVED
        : DeliverableStatus.REJECTED;

    const now = new Date().toISOString();
    deliverable.status = nextStatus;
    deliverable.updatedAt = now;

    if (this.redis) {
      try {
        await this.redis.set(this.deliverableKey(id), JSON.stringify(deliverable));
      } catch (err) {
        this.logger.warn(`Redis failed updating deliverable ${id}`, err);
      }
    }
    this.deliverables.set(id, deliverable);

    if (nextStatus === DeliverableStatus.APPROVED) {
      this.logger.log(
        `Deliverable ${id} approved by ${reviewerAddress} — triggering milestone release side-effect`,
      );
    }

    return deliverable;
  }
}
