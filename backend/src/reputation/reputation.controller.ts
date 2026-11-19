import { Controller, ForbiddenException, Get, Param, Query, Req, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { ReputationService } from './reputation.service';
import { ReputationScoreBreakdownResponseDto, ReputationScoreResponseDto } from './reputation.dto';
import { REPUTATION_LEADERBOARD_DEFAULT_LIMIT } from './reputation.types';
import { JwtAuthGuard } from '../auth/auth.guard';
import { isAdminAddress } from '../admin/admin-addresses.util';
import { config } from '../config/env.config';

/** Shape of `req.user` once `JwtAuthGuard` has run — see `JwtStrategy.validate()`. */
interface AuthenticatedRequest {
  user: { address: string; sub: string };
}

@ApiTags('Reputation')
@Controller('reputation')
export class ReputationController {
  constructor(private readonly reputationService: ReputationService) {}

  @Get('leaderboard')
  @ApiOperation({
    summary: 'List addresses ranked by trust score, highest first',
    description:
      'Sorted by score descending; ties are broken by eventCount descending, then address ascending, ' +
      'so the ordering is fully deterministic and stable across requests. `limit` caps the number of ' +
      'entries returned (top-N only — there is no offset/cursor, since this is a ranking view rather ' +
      'than a paged listing). Unauthenticated: like the escrow read endpoints, this reflects publicly ' +
      'derivable on-chain/dispute history rather than private data, and cannot be written to directly.',
  })
  @ApiQuery({
    name: 'limit',
    required: false,
    example: REPUTATION_LEADERBOARD_DEFAULT_LIMIT,
    description: `Maximum number of top-ranked entries to return. Falls back to ${REPUTATION_LEADERBOARD_DEFAULT_LIMIT} if omitted or not a positive number.`,
  })
  @ApiResponse({ status: 200, type: [ReputationScoreResponseDto] })
  getLeaderboard(@Query('limit') limit?: string) {
    const parsed = Number(limit);
    const effectiveLimit =
      limit !== undefined && Number.isFinite(parsed) && parsed > 0
        ? parsed
        : REPUTATION_LEADERBOARD_DEFAULT_LIMIT;
    return this.reputationService.getLeaderboard(effectiveLimit);
  }

  @Get(':address')
  @ApiOperation({
    summary: 'Get the time-decayed, Sybil-dampened trust score for an address',
    description:
      'Score is derived from escrow completion and dispute-resolution history. Repeated interactions ' +
      'with the same counterparty are dampened with diminishing returns to resist wash-trading and ' +
      'self-dealing, and the score exponentially decays toward zero without new activity. ' +
      'Unauthenticated by design: the score is derived data a caller cannot set directly, not a ' +
      'private value, so it is safe and intended to be publicly checkable like the escrow read endpoints.',
  })
  @ApiParam({ name: 'address', example: 'GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX' })
  @ApiResponse({ status: 200, type: ReputationScoreResponseDto })
  getScore(@Param('address') address: string) {
    return this.reputationService.getScore(address);
  }

  @Get(':address/breakdown')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({
    summary: "Itemized breakdown of the events and weights behind an address's score",
    description:
      'Lists each contributing event with its base weight, amount scaling, and Sybil dampening, ' +
      'so a score can be understood or contested instead of needing a direct database query (#989). ' +
      'Restricted to the address owner or an admin — unlike the plain score, this exposes per-event ' +
      'counterparty history.',
  })
  @ApiParam({ name: 'address', example: 'GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX' })
  @ApiResponse({ status: 200, type: ReputationScoreBreakdownResponseDto })
  @ApiResponse({ status: 403, description: 'Caller is neither the address owner nor an admin' })
  getScoreBreakdown(@Param('address') address: string, @Req() req: AuthenticatedRequest) {
    const isOwner = req.user.address === address;
    if (!isOwner && !isAdminAddress(req.user.address, config.ADMIN_ADDRESSES)) {
      throw new ForbiddenException('Only the address owner or an admin may view this breakdown');
    }
    return this.reputationService.getScoreBreakdown(address);
  }
}
