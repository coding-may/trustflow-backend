export enum DisputeStep {
  PENDING = 'PENDING',
  ESCALATION = 'ESCALATION',
  JUROR_ASSIGNMENT = 'JUROR_ASSIGNMENT',
  VOTING = 'VOTING',
  PAYOUT = 'PAYOUT',
  COMPLETED = 'COMPLETED',
  COMPENSATING = 'COMPENSATING',
  FAILED = 'FAILED',
}

export enum DisputeVerdict {
  DEPOSITOR_WINS = 'DEPOSITOR_WINS',
  BENEFICIARY_WINS = 'BENEFICIARY_WINS',
  SPLIT = 'SPLIT',
}

export interface JurorVote {
  jurorAddress: string;
  vote: 'depositor' | 'beneficiary' | 'split';
  castAt: string;
}

/** A single piece of evidence attached to a dispute, pinned to IPFS. */
export interface DisputeEvidence {
  cid: string;
  size: number;
  filename?: string;
  submittedBy: string;
  submittedAt: string;
}

export interface SagaStepRecord {
  step: DisputeStep;
  startedAt: string;
  completedAt?: string;
  failedAt?: string;
  compensatedAt?: string;
  error?: string;
}

export interface DisputeSaga {
  sagaId: string;
  escrowId: string;
  initiator: string;
  /** Where the dispute originated. Defaults to 'api' for backwards compatibility. */
  origin?: 'api' | 'chain';
  reason: string;
  /**
   * Escrow status observed when this saga started, before it froze the escrow
   * (#635). Compensation restores exactly this value — and only when this
   * saga's own `raiseDispute()` is what moved the escrow to `disputed`.
   */
  priorEscrowStatus?: string;
  currentStep: DisputeStep;
  escalationTxHash?: string;
  assignedJurors?: string[];
  votes?: JurorVote[];
  verdict?: DisputeVerdict;
  payoutTxHash?: string;
  /** Evidence packages pinned during the dispute, in submission order. */
  evidence?: DisputeEvidence[];
  stepHistory: SagaStepRecord[];
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  failedAt?: string;
  compensationReason?: string;
}
