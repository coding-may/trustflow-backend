import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBody,
  ApiHeader,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { GigService } from './gig.service';
import {
  AcceptGigDto,
  AcceptGigSchema,
  CreateGigDto,
  CreateGigSchema,
  SearchGigsSchema,
  UpdateGigDto,
  UpdateGigSchema,
} from './gig.dto';
import { GigStatus } from './gig.entity';
import { JwtAuthGuard } from '../auth/auth.guard';
import { Idempotent } from '../common/idempotency';

@ApiTags('Gigs')
@Controller('gigs')
export class GigController {
  constructor(private readonly gigService: GigService) {}

  @Post()
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth('JWT-auth')
  @HttpCode(HttpStatus.CREATED)
  @Idempotent()
  @ApiOperation({
    summary: 'Post a gig solicitation',
    description:
      'Creates an open gig solicitation. If nobody accepts it within the response window ' +
      '(default 72h), the background expiry sweep automatically marks it as expired.',
  })
  @ApiHeader({
    name: 'Idempotency-Key',
    required: false,
    description:
      'A unique key (e.g. UUID) to ensure this request is idempotent. ' +
      'Retries with the same key and body return the original response without creating a duplicate. ' +
      'Reusing the key with a different body returns 422.',
    schema: { type: 'string' },
  })
  @ApiBody({
    description: 'Gig solicitation details',
    schema: {
      type: 'object',
      required: ['creator', 'title', 'budgetXLM'],
      properties: {
        creator: {
          type: 'string',
          description: 'Stellar address of the gig creator',
          example: 'GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
        },
        title: { type: 'string', example: 'Build a Soroban escrow audit report' },
        budgetXLM: { type: 'string', description: 'Budget in XLM', example: '250' },
        responseWindowHours: {
          type: 'number',
          description: 'Hours to wait for a response before expiring. Defaults to 72.',
          example: 72,
        },
      },
    },
  })
  @ApiResponse({
    status: 201,
    description: 'Gig solicitation created',
    schema: {
      type: 'object',
      properties: {
        id: { type: 'string', example: 'gig-1234567890-ab12cd' },
        creator: { type: 'string' },
        title: { type: 'string' },
        budgetXLM: { type: 'string' },
        status: { type: 'string', enum: ['open', 'accepted', 'expired', 'cancelled'] },
        createdAt: { type: 'string', format: 'date-time' },
        respondBy: { type: 'string', format: 'date-time' },
      },
    },
  })
  async create(@Body() dto: CreateGigDto) {
    const validated = CreateGigSchema.parse(dto);
    return this.gigService.create(validated);
  }

  @Get()
  @ApiOperation({
    summary: 'Search gig solicitations',
    description:
      'Paginated search over gig solicitations, defaulting to open (unaccepted) gigs sorted ' +
      'newest first. Results are cached in Redis for GIG_SEARCH_CACHE_TTL_SECONDS (default 30s) ' +
      'to reduce load on repeated queries; any gig mutation invalidates the cache immediately.',
  })
  @ApiQuery({
    name: 'status',
    required: false,
    enum: GigStatus,
    description: 'Filter by gig status. Defaults to "open".',
  })
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
  @ApiQuery({
    name: 'minBudgetXLM',
    required: false,
    type: String,
    description: 'Minimum budget in XLM.',
  })
  @ApiQuery({
    name: 'maxBudgetXLM',
    required: false,
    type: String,
    description: 'Maximum budget in XLM.',
  })
  @ApiResponse({
    status: 200,
    description: 'Paginated gig solicitations',
    schema: {
      type: 'object',
      properties: {
        items: { type: 'array', items: { type: 'object' } },
        total: { type: 'number' },
        page: { type: 'number' },
        limit: { type: 'number' },
      },
    },
  })
  async search(@Query() query: Record<string, string>) {
    const validated = SearchGigsSchema.parse(query);
    return this.gigService.search(validated);
  }

  @Get(':id')
  @ApiOperation({
    summary: 'Get a gig solicitation by ID',
    description: 'Retrieves gig details including status and response deadline.',
  })
  @ApiParam({ name: 'id', description: 'Gig ID', example: 'gig-1234567890-ab12cd' })
  @ApiResponse({ status: 200, description: 'Gig solicitation details' })
  @ApiResponse({ status: 404, description: 'Gig not found' })
  findOne(@Param('id') id: string) {
    return this.gigService.findById(id);
  }

  @Get('creator/:address')
  @ApiOperation({
    summary: 'List gig solicitations posted by a creator',
    description: 'Retrieves gig solicitations by a creator with optional filtering and pagination.',
  })
  @ApiParam({
    name: 'address',
    description: 'Stellar address of the gig creator',
    example: 'GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
  })
  @ApiQuery({
    name: 'status',
    required: false,
    enum: GigStatus,
    description: 'Filter by gig status.',
  })
  @ApiQuery({
    name: 'minBudgetXLM',
    required: false,
    type: String,
    description: 'Minimum budget in XLM.',
  })
  @ApiQuery({
    name: 'maxBudgetXLM',
    required: false,
    type: String,
    description: 'Maximum budget in XLM.',
  })
  @ApiQuery({
    name: 'offset',
    required: false,
    type: Number,
    description: 'Number of items to skip. Defaults to 0.',
  })
  @ApiQuery({
    name: 'limit',
    required: false,
    type: Number,
    description: 'Maximum number of items to return (max 100). Defaults to 20.',
  })
  @ApiResponse({
    status: 200,
    description: 'Paginated list of gig solicitations',
    schema: {
      type: 'object',
      properties: {
        data: { type: 'array', items: { type: 'object' } },
        total: { type: 'number' },
      },
    },
  })
  findByCreator(
    @Param('address') address: string,
    @Query('status') status?: GigStatus,
    @Query('minBudgetXLM') minBudgetXLM?: string,
    @Query('maxBudgetXLM') maxBudgetXLM?: string,
    @Query('offset') offset?: number,
    @Query('limit') limit?: number,
  ) {
    const safeOffset = Math.max(0, Number(offset) || 0);
    const safeLimit = Math.min(Math.max(1, Number(limit) || 20), 100);
    return this.gigService.findByCreator(address, {
      status,
      minBudgetXLM,
      maxBudgetXLM,
      offset: safeOffset,
      limit: safeLimit,
    });
  }

  @Post(':id/accept')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({
    summary: 'Accept a gig solicitation',
    description: 'Marks an open gig as accepted, removing it from the expiry sweep.',
  })
  @ApiParam({ name: 'id', description: 'Gig ID', example: 'gig-1234567890-ab12cd' })
  @ApiBody({
    description: 'Acceptance details',
    schema: {
      type: 'object',
      required: ['responder'],
      properties: {
        responder: {
          type: 'string',
          description: 'Stellar address of the responder',
          example: 'GYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYY',
        },
      },
    },
  })
  @ApiResponse({ status: 200, description: 'Gig accepted successfully' })
  @ApiResponse({ status: 400, description: 'Gig is not open' })
  @ApiResponse({ status: 404, description: 'Gig not found' })
  async accept(@Param('id') id: string, @Body() dto: AcceptGigDto) {
    const validated = AcceptGigSchema.parse(dto);
    return this.gigService.accept(id, validated.responder);
  }

  @Post(':id/cancel')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({
    summary: 'Cancel a gig solicitation',
    description: 'Withdraws an open gig solicitation, removing it from the expiry sweep.',
  })
  @ApiParam({ name: 'id', description: 'Gig ID', example: 'gig-1234567890-ab12cd' })
  @ApiResponse({ status: 200, description: 'Gig cancelled successfully' })
  @ApiResponse({ status: 400, description: 'Gig is not open' })
  @ApiResponse({ status: 404, description: 'Gig not found' })
  async cancel(@Param('id') id: string) {
    return this.gigService.cancel(id);
  }

  @Put(':id')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({
    summary: 'Update an open gig solicitation',
    description:
      'Updating `responseWindowHours` resets the response deadline to `now + responseWindowHours`, ' +
      'replacing (not extending) the current `respondBy`. Only applies while the gig is `open`; ' +
      'omit the field to leave the deadline unchanged.',
  })
  @ApiParam({ name: 'id', description: 'Gig ID', example: 'gig-1234567890-ab12cd' })
  @ApiResponse({ status: 200, description: 'Gig updated successfully' })
  @ApiResponse({ status: 400, description: 'Gig is not open' })
  @ApiResponse({ status: 404, description: 'Gig not found' })
  async update(@Param('id') id: string, @Body() dto: UpdateGigDto) {
    const validated = UpdateGigSchema.parse(dto);
    return this.gigService.update(id, validated);
  }

  @Delete(':id')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth('JWT-auth')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete a gig solicitation' })
  @ApiParam({ name: 'id', description: 'Gig ID', example: 'gig-1234567890-ab12cd' })
  @ApiResponse({ status: 204, description: 'Gig deleted successfully' })
  @ApiResponse({ status: 400, description: 'Cannot delete accepted gig' })
  @ApiResponse({ status: 404, description: 'Gig not found' })
  async remove(@Param('id') id: string) {
    await this.gigService.remove(id);
  }
}
