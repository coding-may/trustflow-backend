import {
  Controller,
  Post,
  Get,
  Param,
  Body,
  HttpCode,
  HttpStatus,
  NotFoundException,
  UseGuards,
  Req,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiParam, ApiBearerAuth } from '@nestjs/swagger';
import { DisputeSagaService } from './dispute-saga.service';
import {
  EscalateDisputeDto,
  AssignJurorsDto,
  CastVoteDto,
  ExecutePayoutDto,
  DisputeSagaResponseDto,
  SubmitEvidenceDto,
  DisputeEvidenceDto,
} from './dispute.dto';
import { JwtAuthGuard } from '../auth/auth.guard';
import { AdminGuard } from '../admin/admin.guard';

/**
 * Shape of `req.user` once `JwtAuthGuard` has run — see
 * `JwtStrategy.validate()` (src/auth/jwt.strategy.ts).
 */
interface AuthenticatedRequest {
  user: { address: string; sub: string };
}

@ApiTags('Dispute Resolution')
@ApiBearerAuth('JWT-auth')
@UseGuards(JwtAuthGuard)
@Controller('dispute')
export class DisputeSagaController {
  constructor(private readonly sagaService: DisputeSagaService) {}

  @Get()
  @ApiOperation({ summary: 'List all dispute sagas' })
  @ApiResponse({ status: 200, type: [DisputeSagaResponseDto] })
  findAll() {
    return this.sagaService.findAll();
  }

  @Get(':sagaId')
  @ApiOperation({ summary: 'Get a dispute saga by ID' })
  @ApiParam({ name: 'sagaId', example: 'saga-1234567890-abc' })
  @ApiResponse({ status: 200, type: DisputeSagaResponseDto })
  @ApiResponse({ status: 404, description: 'Saga not found' })
  findOne(@Param('sagaId') sagaId: string) {
    return this.sagaService.findById(sagaId);
  }

  @Get('escrow/:escrowId')
  @ApiOperation({ summary: 'Get the active dispute saga for an escrow' })
  @ApiParam({ name: 'escrowId', example: '8cbb9b5e-1f41-47c2-a804-8337caa7f005' })
  @ApiResponse({ status: 200, type: DisputeSagaResponseDto })
  @ApiResponse({ status: 404, description: 'No active dispute saga for this escrow' })
  async findByEscrow(@Param('escrowId') escrowId: string) {
    const saga = await this.sagaService.findByEscrowId(escrowId);
    if (!saga) throw new NotFoundException(`No active dispute saga for escrow ${escrowId}`);
    return saga;
  }

  @Post('escrow/:escrowId/escalate')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Step 1 — Escalate dispute',
    description:
      'Opens a new dispute saga for the escrow. The authenticated wallet must be either the ' +
      'depositor or beneficiary of the escrow. Freezes the escrow and notifies juror pool via Discord. ' +
      'Compensating action: restores escrow status to active if this step fails.',
  })
  @ApiParam({ name: 'escrowId', example: '8cbb9b5e-1f41-47c2-a804-8337caa7f005' })
  @ApiResponse({ status: 201, type: DisputeSagaResponseDto })
  @ApiResponse({
    status: 400,
    description: 'Escrow already released or already has active dispute',
  })
  @ApiResponse({ status: 403, description: 'Only depositor or beneficiary can escalate dispute' })
  @ApiResponse({ status: 404, description: 'Escrow not found' })
  @ApiResponse({ status: 409, description: 'Active saga already exists for this escrow' })
  escalate(
    @Param('escrowId') escrowId: string,
    @Body() dto: EscalateDisputeDto,
    @Req() req: AuthenticatedRequest,
  ) {
    // Bind initiator to authenticated wallet instead of trusting the body
    const escalateDto: EscalateDisputeDto = {
      ...dto,
      initiator: req.user.address,
    };
    return this.sagaService.escalate(escrowId, escalateDto);
  }

  @Post(':sagaId/evidence')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Attach dispute evidence',
    description:
      'Pins a base64-encoded evidence file to IPFS and records its CID on the saga. ' +
      'The same 10 MB decoded size limit as deliverable uploads is enforced on the raw ' +
      'request before any content is decoded or forwarded to pinning storage.',
  })
  @ApiParam({ name: 'sagaId', example: 'saga-1234567890-abc' })
  @ApiResponse({ status: 201, type: DisputeEvidenceDto })
  @ApiResponse({ status: 400, description: 'Invalid or oversized evidence content' })
  @ApiResponse({ status: 403, description: 'Caller is not a party to the dispute' })
  @ApiResponse({ status: 404, description: 'Saga not found' })
  attachEvidence(
    @Param('sagaId') sagaId: string,
    @Body() dto: SubmitEvidenceDto,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.sagaService.attachEvidence(sagaId, dto, req.user.address);
  }

  @Post(':sagaId/assign-jurors')
  @UseGuards(AdminGuard)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Step 2 — Assign jurors (Admin only)',
    description:
      'Assigns 3–7 jurors to the dispute. Requires admin authentication. ' +
      'Compensating action: clears the juror list and reverts the saga to the assignment step.',
  })
  @ApiParam({ name: 'sagaId', example: 'saga-1234567890-abc' })
  @ApiResponse({ status: 200, type: DisputeSagaResponseDto })
  @ApiResponse({ status: 400, description: 'Saga not at JUROR_ASSIGNMENT step' })
  @ApiResponse({ status: 403, description: 'Admin access required' })
  assignJurors(@Param('sagaId') sagaId: string, @Body() dto: AssignJurorsDto) {
    return this.sagaService.assignJurors(sagaId, dto);
  }

  @Post(':sagaId/vote')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Step 3 — Cast a juror vote',
    description:
      'Records a vote from an assigned juror. When all jurors have voted, the verdict is computed ' +
      'automatically via majority rule and the saga advances to the PAYOUT step. ' +
      'Compensating action: removes the vote if an error occurs mid-recording.',
  })
  @ApiParam({ name: 'sagaId', example: 'saga-1234567890-abc' })
  @ApiResponse({ status: 200, type: DisputeSagaResponseDto })
  @ApiResponse({ status: 400, description: 'Juror not assigned or saga not at VOTING step' })
  @ApiResponse({ status: 403, description: 'Authenticated wallet does not match juror address' })
  @ApiResponse({ status: 409, description: 'Juror has already voted' })
  castVote(
    @Param('sagaId') sagaId: string,
    @Body() dto: CastVoteDto,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.sagaService.castVote(sagaId, dto, req.user?.address);
  }

  @Post(':sagaId/payout')
  @UseGuards(AdminGuard)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Step 4 — Execute payout (Admin only)',
    description:
      'Releases funds based on the recorded verdict. Requires admin authentication. ' +
      'For SPLIT verdicts, an optional splitPercentage (0–100, depositor share) can be provided; defaults to 50. ' +
      'Compensating action: re-flags the escrow as disputed and marks it for manual admin review.',
  })
  @ApiParam({ name: 'sagaId', example: 'saga-1234567890-abc' })
  @ApiResponse({ status: 200, type: DisputeSagaResponseDto })
  @ApiResponse({ status: 400, description: 'No verdict or saga not at PAYOUT step' })
  @ApiResponse({ status: 403, description: 'Admin access required' })
  executePayout(@Param('sagaId') sagaId: string, @Body() dto: ExecutePayoutDto) {
    return this.sagaService.executePayout(sagaId, dto);
  }
}
