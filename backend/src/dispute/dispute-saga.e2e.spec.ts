/**
 * End-to-end integration tests for the dispute saga lifecycle
 *
 * Covers full state machine transitions from escalation through juror assignment,
 * commit-reveal voting, and final payout execution for all three verdict types:
 * - DEPOSITOR_WINS
 * - BENEFICIARY_WINS
 * - SPLIT
 *
 * Also verifies compensation triggers on simulated failures and event emission
 * at each saga phase.
 */

import { Test, TestingModule } from '@nestjs/testing';
import { DisputeSagaService, SAGA_EVENTS } from './dispute-saga.service';
import { DisputeStep, DisputeVerdict } from './dispute.types';
import { EscrowService } from '../escrow/escrow.service';
import { WebhookService } from '../webhook/webhook.service';
import { NotificationService } from '../notification/notification.service';
import { ArweaveArchiveService } from './arweave-archive.service';
import { MetricsService } from '../monitoring/metrics.service';
import { AuditService } from '../audit/audit.service';
import { DiscordService } from '../webhook/discord.service';
import { EscrowChainStateClient } from '../escrow-reconciliation/escrow-chain-state.client';

describe('DisputeSaga E2E', () => {
  let sagaService: DisputeSagaService;
  let escrowService: jest.Mocked<EscrowService>;
  let webhookService: jest.Mocked<WebhookService>;
  let notificationService: jest.Mocked<NotificationService>;

  const DEPOSITOR = 'GDEPOSITOR123456789012345678901234567890123456';
  const BENEFICIARY = 'GBENEFICIARY123456789012345678901234567890123';
  const JUROR1 = 'GJUROR1234567890123456789012345678901234567890';
  const JUROR2 = 'GJUROR2234567890123456789012345678901234567890';
  const JUROR3 = 'GJUROR3234567890123456789012345678901234567890';

  const createMockEscrow = (id: string, status: 'active' | 'disputed' = 'active') => ({
    id,
    depositor: DEPOSITOR,
    beneficiary: BENEFICIARY,
    amountXLM: '100.0000000',
    status,
    disputedAt: status === 'disputed' ? new Date().toISOString() : undefined,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });

  beforeEach(async () => {
    const mockEscrowService = {
      findById: jest.fn(),
      findAll: jest.fn().mockResolvedValue([]),
      raiseDispute: jest.fn(),
      release: jest.fn(),
      cancel: jest.fn(),
      split: jest.fn(),
      correctStatus: jest.fn(),
      applyChainState: jest.fn(),
    };

    const mockWebhookService = {
      dispatch: jest.fn().mockResolvedValue(undefined),
    };

    const mockNotificationService = {
      notifyDisputeEscalated: jest.fn().mockResolvedValue(undefined),
      notifyJurorsAssigned: jest.fn().mockResolvedValue(undefined),
      notifyVerdictReached: jest.fn().mockResolvedValue(undefined),
      notifyPayoutExecuted: jest.fn().mockResolvedValue(undefined),
    };

    const mockArweaveService = {
      archiveDispute: jest.fn().mockResolvedValue('arweave-tx-id-123'),
    };

    const mockMetricsService = {
      increment: jest.fn(),
      gauge: jest.fn(),
      histogram: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DisputeSagaService,
        { provide: EscrowService, useValue: mockEscrowService },
        { provide: WebhookService, useValue: mockWebhookService },
        { provide: NotificationService, useValue: mockNotificationService },
        { provide: ArweaveArchiveService, useValue: mockArweaveService },
        { provide: 'REDIS_CLIENT', useValue: null },
        { provide: MetricsService, useValue: mockMetricsService },
        { provide: AuditService, useValue: null },
        { provide: DiscordService, useValue: null },
        { provide: EscrowChainStateClient, useValue: null },
      ],
    }).compile();

    sagaService = module.get<DisputeSagaService>(DisputeSagaService);
    escrowService = module.get(EscrowService);
    webhookService = module.get(WebhookService);
    notificationService = module.get(NotificationService);
  });

  describe('Full lifecycle: DEPOSITOR_WINS', () => {
    it('completes the saga from escalation through payout when depositor wins', async () => {
      const escrowId = 'escrow-depositor-wins';
      const mockEscrow = createMockEscrow(escrowId);
      escrowService.findById.mockResolvedValue(mockEscrow as any);
      escrowService.raiseDispute.mockResolvedValue({ ...mockEscrow, status: 'disputed' } as any);

      // Step 1: Escalate
      const saga = await sagaService.escalate(escrowId, {
        initiator: DEPOSITOR,
        reason: 'Work not delivered as agreed',
      });

      expect(saga.currentStep).toBe(DisputeStep.JUROR_ASSIGNMENT);
      expect(saga.escrowId).toBe(escrowId);
      expect(saga.initiator).toBe(DEPOSITOR);
      expect(webhookService.dispatch).toHaveBeenCalledWith(
        SAGA_EVENTS.RAISED,
        expect.objectContaining({ escrowId, sagaId: saga.sagaId }),
      );
      expect(webhookService.dispatch).toHaveBeenCalledWith(
        SAGA_EVENTS.ESCALATED,
        expect.objectContaining({ sagaId: saga.sagaId }),
      );

      // Step 2: Assign jurors
      const withJurors = await sagaService.assignJurors(saga.sagaId, {
        jurors: [JUROR1, JUROR2, JUROR3],
      });

      expect(withJurors.currentStep).toBe(DisputeStep.VOTING);
      expect(withJurors.assignedJurors).toEqual([JUROR1, JUROR2, JUROR3]);
      expect(webhookService.dispatch).toHaveBeenCalledWith(
        SAGA_EVENTS.JURORS_ASSIGNED,
        expect.objectContaining({ sagaId: saga.sagaId, jurors: [JUROR1, JUROR2, JUROR3] }),
      );

      // Step 3: Voting - majority votes for depositor
      await sagaService.castVote(saga.sagaId, { jurorAddress: JUROR1, vote: 'depositor' });
      await sagaService.castVote(saga.sagaId, { jurorAddress: JUROR2, vote: 'depositor' });
      const afterVoting = await sagaService.castVote(saga.sagaId, {
        jurorAddress: JUROR3,
        vote: 'beneficiary',
      });

      expect(afterVoting.currentStep).toBe(DisputeStep.PAYOUT);
      expect(afterVoting.verdict).toBe(DisputeVerdict.DEPOSITOR_WINS);
      expect(afterVoting.votes).toHaveLength(3);
      expect(webhookService.dispatch).toHaveBeenCalledWith(
        SAGA_EVENTS.VERDICT_REACHED,
        expect.objectContaining({ sagaId: saga.sagaId, verdict: DisputeVerdict.DEPOSITOR_WINS }),
      );

      // Step 4: Execute payout
      const completed = await sagaService.executePayout(saga.sagaId, {});

      expect(completed.currentStep).toBe(DisputeStep.COMPLETED);
      expect(completed.payoutTxHash).toBeDefined();
      expect(escrowService.cancel).toHaveBeenCalledWith(escrowId);
      expect(webhookService.dispatch).toHaveBeenCalledWith(
        SAGA_EVENTS.PAYOUT_EXECUTED,
        expect.objectContaining({ sagaId: saga.sagaId, verdict: DisputeVerdict.DEPOSITOR_WINS }),
      );
      expect(webhookService.dispatch).toHaveBeenCalledWith(
        SAGA_EVENTS.SAGA_COMPLETED,
        expect.objectContaining({ sagaId: saga.sagaId }),
      );
    });
  });

  describe('Full lifecycle: BENEFICIARY_WINS', () => {
    it('completes the saga with beneficiary payout when beneficiary wins', async () => {
      const escrowId = 'escrow-beneficiary-wins';
      const mockEscrow = createMockEscrow(escrowId);
      escrowService.findById.mockResolvedValue(mockEscrow as any);
      escrowService.raiseDispute.mockResolvedValue({ ...mockEscrow, status: 'disputed' } as any);

      // Escalate
      const saga = await sagaService.escalate(escrowId, {
        initiator: BENEFICIARY,
        reason: 'Work completed, depositor refusing payment',
      });

      // Assign jurors
      await sagaService.assignJurors(saga.sagaId, { jurors: [JUROR1, JUROR2, JUROR3] });

      // Voting - majority votes for beneficiary
      await sagaService.castVote(saga.sagaId, { jurorAddress: JUROR1, vote: 'beneficiary' });
      await sagaService.castVote(saga.sagaId, { jurorAddress: JUROR2, vote: 'beneficiary' });
      const afterVoting = await sagaService.castVote(saga.sagaId, {
        jurorAddress: JUROR3,
        vote: 'depositor',
      });

      expect(afterVoting.verdict).toBe(DisputeVerdict.BENEFICIARY_WINS);

      // Execute payout
      const completed = await sagaService.executePayout(saga.sagaId, {});

      expect(completed.currentStep).toBe(DisputeStep.COMPLETED);
      expect(escrowService.release).toHaveBeenCalledWith(escrowId);
      expect(webhookService.dispatch).toHaveBeenCalledWith(
        SAGA_EVENTS.PAYOUT_EXECUTED,
        expect.objectContaining({ verdict: DisputeVerdict.BENEFICIARY_WINS }),
      );
    });
  });

  describe('Full lifecycle: SPLIT', () => {
    it('completes the saga with split payout when verdict is split', async () => {
      const escrowId = 'escrow-split';
      const mockEscrow = createMockEscrow(escrowId);
      escrowService.findById.mockResolvedValue(mockEscrow as any);
      escrowService.raiseDispute.mockResolvedValue({ ...mockEscrow, status: 'disputed' } as any);

      // Escalate
      const saga = await sagaService.escalate(escrowId, {
        initiator: DEPOSITOR,
        reason: 'Partial delivery, quality issues',
      });

      // Assign jurors
      await sagaService.assignJurors(saga.sagaId, { jurors: [JUROR1, JUROR2, JUROR3] });

      // Voting - majority votes for split
      await sagaService.castVote(saga.sagaId, { jurorAddress: JUROR1, vote: 'split' });
      await sagaService.castVote(saga.sagaId, { jurorAddress: JUROR2, vote: 'split' });
      const afterVoting = await sagaService.castVote(saga.sagaId, {
        jurorAddress: JUROR3,
        vote: 'depositor',
      });

      expect(afterVoting.verdict).toBe(DisputeVerdict.SPLIT);

      // Execute payout with custom split percentage
      const completed = await sagaService.executePayout(saga.sagaId, { splitPercentage: 60 });

      expect(completed.currentStep).toBe(DisputeStep.COMPLETED);
      expect(escrowService.split).toHaveBeenCalledWith(escrowId, 60);
      expect(webhookService.dispatch).toHaveBeenCalledWith(
        SAGA_EVENTS.PAYOUT_EXECUTED,
        expect.objectContaining({ verdict: DisputeVerdict.SPLIT }),
      );
    });
  });

  describe('Compensation on failures', () => {
    it('compensates escalation when raiseDispute fails', async () => {
      const escrowId = 'escrow-escalation-fail';
      const mockEscrow = createMockEscrow(escrowId);
      escrowService.findById.mockResolvedValue(mockEscrow as any);
      escrowService.raiseDispute.mockRejectedValue(new Error('Chain transaction failed'));

      await expect(
        sagaService.escalate(escrowId, {
          initiator: DEPOSITOR,
          reason: 'Test failure',
        }),
      ).rejects.toThrow('Chain transaction failed');

      // Verify compensation event was dispatched
      expect(webhookService.dispatch).toHaveBeenCalledWith(
        SAGA_EVENTS.SAGA_FAILED,
        expect.objectContaining({
          reason: 'Chain transaction failed',
          step: DisputeStep.ESCALATION,
        }),
      );
    });

    it('compensates payout and marks escrow for manual review when payout fails', async () => {
      const escrowId = 'escrow-payout-fail';
      const mockEscrow = createMockEscrow(escrowId);
      escrowService.findById.mockResolvedValue(mockEscrow as any);
      escrowService.raiseDispute.mockResolvedValue({ ...mockEscrow, status: 'disputed' } as any);
      escrowService.release.mockRejectedValue(new Error('Release transaction failed'));

      // Complete saga up to payout
      const saga = await sagaService.escalate(escrowId, {
        initiator: BENEFICIARY,
        reason: 'Test payout failure',
      });
      await sagaService.assignJurors(saga.sagaId, { jurors: [JUROR1, JUROR2, JUROR3] });
      await sagaService.castVote(saga.sagaId, { jurorAddress: JUROR1, vote: 'beneficiary' });
      await sagaService.castVote(saga.sagaId, { jurorAddress: JUROR2, vote: 'beneficiary' });
      await sagaService.castVote(saga.sagaId, { jurorAddress: JUROR3, vote: 'beneficiary' });

      // Attempt payout - should fail and compensate
      await expect(sagaService.executePayout(saga.sagaId, {})).rejects.toThrow(
        'Release transaction failed',
      );

      // Verify compensation: escrow marked for manual review
      expect(escrowService.correctStatus).toHaveBeenCalledWith(
        escrowId,
        expect.objectContaining({
          status: 'disputed',
          requiresManualReview: true,
        }),
      );

      expect(webhookService.dispatch).toHaveBeenCalledWith(
        SAGA_EVENTS.SAGA_FAILED,
        expect.objectContaining({
          step: DisputeStep.PAYOUT,
        }),
      );
    });
  });

  describe('Event emission', () => {
    it('emits all expected events at each saga phase', async () => {
      const escrowId = 'escrow-event-check';
      const mockEscrow = createMockEscrow(escrowId);
      escrowService.findById.mockResolvedValue(mockEscrow as any);
      escrowService.raiseDispute.mockResolvedValue({ ...mockEscrow, status: 'disputed' } as any);

      // Track all events
      const events: string[] = [];
      webhookService.dispatch.mockImplementation(async (event: string) => {
        events.push(event);
      });

      const saga = await sagaService.escalate(escrowId, {
        initiator: DEPOSITOR,
        reason: 'Event verification test',
      });

      await sagaService.assignJurors(saga.sagaId, { jurors: [JUROR1, JUROR2, JUROR3] });

      await sagaService.castVote(saga.sagaId, { jurorAddress: JUROR1, vote: 'depositor' });
      await sagaService.castVote(saga.sagaId, { jurorAddress: JUROR2, vote: 'depositor' });
      await sagaService.castVote(saga.sagaId, { jurorAddress: JUROR3, vote: 'beneficiary' });

      await sagaService.executePayout(saga.sagaId, {});

      // Verify all expected events were emitted
      expect(events).toContain(SAGA_EVENTS.RAISED);
      expect(events).toContain(SAGA_EVENTS.ESCALATED);
      expect(events).toContain(SAGA_EVENTS.JURORS_ASSIGNED);
      expect(events).toContain(SAGA_EVENTS.VERDICT_REACHED);
      expect(events).toContain(SAGA_EVENTS.PAYOUT_EXECUTED);
      expect(events).toContain(SAGA_EVENTS.SAGA_COMPLETED);

      // Verify vote events (3 times, one per juror)
      const voteEvents = events.filter(e => e === SAGA_EVENTS.VOTE_CAST);
      expect(voteEvents).toHaveLength(3);
    });
  });

  describe('State transition validation', () => {
    it('rejects operations on a saga in the wrong step', async () => {
      const escrowId = 'escrow-wrong-step';
      const mockEscrow = createMockEscrow(escrowId);
      escrowService.findById.mockResolvedValue(mockEscrow as any);
      escrowService.raiseDispute.mockResolvedValue({ ...mockEscrow, status: 'disputed' } as any);

      const saga = await sagaService.escalate(escrowId, {
        initiator: DEPOSITOR,
        reason: 'State validation test',
      });

      // Saga is at JUROR_ASSIGNMENT, attempt to cast vote (requires VOTING step)
      await expect(
        sagaService.castVote(saga.sagaId, { jurorAddress: JUROR1, vote: 'depositor' }),
      ).rejects.toThrow(/expected VOTING/);

      // Saga is at JUROR_ASSIGNMENT, attempt payout (requires PAYOUT step)
      await expect(sagaService.executePayout(saga.sagaId, {})).rejects.toThrow(/expected PAYOUT/);
    });

    it('prevents duplicate escalation for the same escrow', async () => {
      const escrowId = 'escrow-duplicate';
      const mockEscrow = createMockEscrow(escrowId);
      escrowService.findById.mockResolvedValue(mockEscrow as any);
      escrowService.raiseDispute.mockResolvedValue({ ...mockEscrow, status: 'disputed' } as any);

      await sagaService.escalate(escrowId, {
        initiator: DEPOSITOR,
        reason: 'First dispute',
      });

      // Attempt second escalation for the same escrow
      await expect(
        sagaService.escalate(escrowId, {
          initiator: BENEFICIARY,
          reason: 'Second dispute',
        }),
      ).rejects.toThrow(/active dispute saga already exists/);
    });
  });
});
