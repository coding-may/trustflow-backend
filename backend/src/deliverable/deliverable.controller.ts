import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBody,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { ZodError } from 'zod';
import { JwtAuthGuard } from '../auth/auth.guard';
import { Idempotent } from '../common/idempotency';
import { DeliverableService } from './deliverable.service';
import { UploadDeliverableDto, UploadDeliverableSchema, ReviewDeliverableDto, ReviewDeliverableSchema } from './deliverable.dto';
import { MAX_BASE64_CONTENT_LENGTH } from '../ipfs-pinning/ipfs-pinning.types';

/** Shape of `req.user` once `JwtAuthGuard` has run — see `JwtStrategy.validate()`. */
interface AuthenticatedRequest {
  user: { address: string; sub: string };
}

@ApiTags('Deliverables')
@ApiBearerAuth('JWT-auth')
@UseGuards(JwtAuthGuard)
@Controller('deliverables')
export class DeliverableController {
  constructor(private readonly deliverableService: DeliverableService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @Idempotent()
  @ApiOperation({
    summary: 'Upload a deliverable and pin to IPFS',
    description:
      'Only the freelancer who accepted the gig can upload for it: the gig must exist, be ' +
      "accepted, and `freelancer` must be both the gig's accepted freelancer and the " +
      'authenticated wallet. `content` must be valid base64 of at most 10 MB decoded.',
  })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['gigId', 'freelancer', 'content', 'filename'],
      properties: {
        gigId: { type: 'string', example: 'gig-1234567890-ab12cd' },
        freelancer: { type: 'string', example: 'GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX' },
        content: {
          type: 'string',
          description: 'Base64-encoded file content (at most 10 MB decoded)',
          maxLength: MAX_BASE64_CONTENT_LENGTH,
        },
        filename: { type: 'string', example: 'audit-report.pdf' },
      },
    },
  })
  @ApiResponse({ status: 201, description: 'Deliverable uploaded and pinned' })
  @ApiResponse({
    status: 400,
    description: 'Invalid payload, or content is not valid base64 / exceeds the size limit',
  })
  @ApiResponse({
    status: 403,
    description: 'Gig was not accepted by both the given freelancer and the authenticated wallet',
  })
  @ApiResponse({ status: 404, description: 'Gig not found' })
  @ApiResponse({ status: 409, description: 'Gig has not been accepted' })
  @ApiResponse({ status: 503, description: 'IPFS pinning failed' })
  async upload(@Body() dto: UploadDeliverableDto, @Req() req: AuthenticatedRequest) {
    let validated: UploadDeliverableDto;
    try {
      validated = UploadDeliverableSchema.parse(dto);
    } catch (err) {
      if (err instanceof ZodError) {
        throw new BadRequestException(err.errors[0]?.message ?? 'Invalid deliverable payload');
      }
      throw err;
    }
    return this.deliverableService.upload(validated, req.user.address);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a deliverable by ID' })
  @ApiParam({ name: 'id', example: 'del-1234567890-ab12cd' })
  @ApiResponse({ status: 200, description: 'Deliverable details' })
  @ApiResponse({ status: 404, description: 'Deliverable not found' })
  findOne(@Param('id') id: string) {
    return this.deliverableService.findById(id);
  }

  @Get('gig/:gigId')
  @ApiOperation({ summary: 'List deliverables for a gig' })
  @ApiParam({ name: 'gigId', example: 'gig-1234567890-ab12cd' })
  @ApiQuery({
    name: 'page',
    required: false,
    type: Number,
    description: 'Page number (1-indexed). Defaults to 1.',
  })
  @ApiQuery({
    name: 'limit',
    required: false,
    type: Number,
    description: 'Results per page, up to 100. Defaults to 20.',
  })
  @ApiResponse({ status: 200, description: 'List of deliverables' })
  findByGig(
    @Param('gigId') gigId: string,
    @Query('page') page?: number,
    @Query('limit') limit?: number,
  ) {
    const pageNum = page !== undefined ? Number(page) : undefined;
    const limitNum = limit !== undefined ? Number(limit) : undefined;
    return this.deliverableService.findByGig(gigId, {
      page: Number.isFinite(pageNum) ? pageNum : undefined,
      limit: Number.isFinite(limitNum) ? limitNum : undefined,
    });
  }

  @Post(':id/review')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Review a deliverable (approve or reject)' })
  @ApiParam({ name: 'id', example: 'del-1234567890-ab12cd' })
  @ApiResponse({ status: 200, description: 'Deliverable reviewed successfully' })
  @ApiResponse({ status: 409, description: 'Deliverable is already finalized' })
  async review(
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() req: AuthenticatedRequest,
  ) {
    let validated: ReviewDeliverableDto;
    try {
      validated = ReviewDeliverableSchema.parse(body);
    } catch (err) {
      if (err instanceof ZodError) {
        throw new BadRequestException(err.errors[0]?.message ?? 'Invalid review payload');
      }
      throw err;
    }
    return this.deliverableService.review(id, validated, req.user.address);
  }
}
