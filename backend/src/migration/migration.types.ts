export enum MigrationPhase {
  EXPAND = 'EXPAND',
  BACKFILL = 'BACKFILL',
  CONTRACT = 'CONTRACT',
  ROLLBACK = 'ROLLBACK',
}

export enum MigrationStatus {
  PENDING = 'PENDING',
  EXPANDING = 'EXPANDING',
  BACKFILLING = 'BACKFILLING',
  CONTRACTING = 'CONTRACTING',
  COMPLETED = 'COMPLETED',
  ROLLING_BACK = 'ROLLING_BACK',
  ROLLED_BACK = 'ROLLED_BACK',
  FAILED = 'FAILED',
}

export interface BackfillProgress {
  totalRows: number;
  processedRows: number;
  failedRows: number;
  cursor?: string;
  batchSize: number;
  startedAt?: string;
  updatedAt?: string;
  completedAt?: string;
}

export interface MigrationStepRecord {
  phase: MigrationPhase;
  startedAt: string;
  completedAt?: string;
  failedAt?: string;
  error?: string;
}

export interface MigrationRun {
  runId: string;
  migrationName: string;
  targetTable: string;
  status: MigrationStatus;
  currentPhase?: MigrationPhase;
  progress: BackfillProgress;
  stepHistory: MigrationStepRecord[];
  dryRun?: boolean;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  failedAt?: string;
  rollbackReason?: string;
}

/** Result of processing a single bounded backfill batch. */
export interface BackfillBatchResult {
  /** Rows successfully backfilled in this batch. */
  processed: number;
  /** Rows that failed to backfill in this batch. */
  failed: number;
  /** Cursor to resume from on the next batch. */
  nextCursor?: string;
  /** True once there are no more rows left to backfill. */
  done: boolean;
}

/**
 * Contract every zero-downtime schema migration must implement.
 *
 * `expand()` and `contract()` are expected to be additive/non-blocking DDL —
 * they must not hold a long-lived lock on the target table. `backfillBatch()`
 * is called repeatedly with a bounded batch size so a large backfill never
 * runs inside a single long transaction. If any phase throws, the runner
 * invokes the matching `rollbackContract()`/`rollbackExpand()` compensating
 * actions, which must be safe to call even if the forward phase only
 * partially applied.
 */
export abstract class SchemaMigration {
  abstract readonly name: string;
  abstract readonly targetTable: string;
  abstract readonly description: string;

  abstract expand(): Promise<void>;

  /** Rows still needing backfill, counted once before the backfill phase starts. */
  abstract countPending(): Promise<number>;

  abstract backfillBatch(
    cursor: string | undefined,
    batchSize: number,
  ): Promise<BackfillBatchResult>;

  /** Finalizing change (e.g. drop the deprecated column) — runs only after backfill completes. */
  abstract contract(): Promise<void>;

  /** Compensating action undoing `expand()`. */
  abstract rollbackExpand(): Promise<void>;

  /** Compensating action undoing `contract()`. */
  abstract rollbackContract(): Promise<void>;
}
