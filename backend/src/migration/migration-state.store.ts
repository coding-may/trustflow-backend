import { Inject, Injectable, OnModuleInit, Optional } from '@nestjs/common';
import { SanitizedLogger } from '../common/logging/sanitized-logger';
import { Redis } from 'ioredis';
import { REDIS_CLIENT } from '../common/redis/redis.module';
import { MetricsService } from '../monitoring/metrics.service';
import { MigrationRun, MigrationStatus } from './migration.types';
import { config } from '../config/env.config';

const RUN_KEY_PREFIX = 'migration:run:';
const RUNS_INDEX_KEY = 'migration:runs:index';
const ACTIVE_BY_NAME_PREFIX = 'migration:active-by-name:';

/** Emitted (see `GET /metrics`) every time a call falls back to the in-memory store. */
export const MIGRATION_STATE_PERSISTENCE_FALLBACK_METRIC =
  'migration_state_persistence_fallback_total';

/**
 * Migration run-history store. Backed by Redis so run history (and the "is a migration
 * currently running" check) survives restarts and is shared across instances — see
 * PERSISTENT_STORAGE_SPIKE.md and its "Follow-up decisions" addendum (#190). Ironically, the
 * framework that runs schema migrations previously had no persistent record of having run one.
 *
 * Falls back to a process-local Map when Redis is unavailable, logged at `error` level and
 * counted via `MIGRATION_STATE_PERSISTENCE_FALLBACK_METRIC`.
 */
@Injectable()
export class MigrationStateStore implements OnModuleInit {
  private readonly logger = new SanitizedLogger(MigrationStateStore.name);
  /** Fallback stores, only used while Redis is unavailable. */
  private readonly runs: Map<string, MigrationRun> = new Map();
  /** migrationName -> runId of the run currently in progress, if any. */
  private readonly activeRunByName: Map<string, string> = new Map();

  constructor(
    @Optional() @Inject(REDIS_CLIENT) private readonly redis: Redis | null = null,
    @Optional() private readonly metrics?: MetricsService,
  ) {}

  onModuleInit(): void {
    if (!this.redis && config.NODE_ENV === 'production') {
      throw new Error(
        'MigrationStateStore requires REDIS_URL to be configured in production — refusing to ' +
          'start with per-instance in-memory storage, which would silently diverge across instances.',
      );
    }
  }

  async create(run: MigrationRun): Promise<void> {
    if (this.redis) {
      try {
        const results = await this.redis
          .multi()
          .set(this.runKey(run.runId), JSON.stringify(run))
          .sadd(RUNS_INDEX_KEY, run.runId)
          .exec();
        this.assertTransactionOk(results);
        return;
      } catch (err) {
        this.logFallback('create', err);
      }
    }

    this.runs.set(run.runId, run);
  }

  async save(run: MigrationRun): Promise<void> {
    run.updatedAt = new Date().toISOString();

    if (this.redis) {
      try {
        const multi = this.redis
          .multi()
          .set(this.runKey(run.runId), JSON.stringify(run))
          .sadd(RUNS_INDEX_KEY, run.runId);

        // Set TTL for terminal states (COMPLETED, ROLLED_BACK, FAILED)
        if (this.isTerminalState(run.status)) {
          const ttlSeconds = config.MIGRATION_RUN_TTL_SECONDS;
          multi.expire(this.runKey(run.runId), ttlSeconds);
        }

        const results = await multi.exec();
        this.assertTransactionOk(results);

        // Prune old runs for this migration after saving
        await this.pruneOldRuns(run.migrationName);
        return;
      } catch (err) {
        this.logFallback('save', err);
      }
    }

    this.runs.set(run.runId, run);
  }

  async findById(runId: string): Promise<MigrationRun | undefined> {
    if (this.redis) {
      try {
        const raw = await this.redis.get(this.runKey(runId));
        return raw ? (JSON.parse(raw) as MigrationRun) : undefined;
      } catch (err) {
        this.logFallback('findById', err);
      }
    }

    return this.runs.get(runId);
  }

  async findAll(): Promise<MigrationRun[]> {
    if (this.redis) {
      try {
        const ids = await this.redis.smembers(RUNS_INDEX_KEY);
        if (ids.length === 0) return [];
        const raw = await this.redis.mget(...ids.map(id => this.runKey(id)));
        
        // Filter out expired keys and remove stale IDs from index
        const staleIds: string[] = [];
        const runs: MigrationRun[] = [];
        
        for (let i = 0; i < raw.length; i++) {
          if (raw[i] === null) {
            staleIds.push(ids[i]);
          } else {
            runs.push(JSON.parse(raw[i]!) as MigrationRun);
          }
        }

        // Clean up stale index entries
        if (staleIds.length > 0) {
          await this.redis.srem(RUNS_INDEX_KEY, ...staleIds).catch(err => {
            this.logger.warn(`Failed to remove stale run IDs from index: ${err}`);
          });
        }

        return runs.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      } catch (err) {
        this.logFallback('findAll', err);
      }
    }

    return [...this.runs.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async findActiveByName(migrationName: string): Promise<MigrationRun | undefined> {
    if (this.redis) {
      try {
        const runId = await this.redis.get(this.activeKey(migrationName));
        return runId ? await this.findById(runId) : undefined;
      } catch (err) {
        this.logFallback('findActiveByName', err);
      }
    }

    const runId = this.activeRunByName.get(migrationName);
    return runId ? this.runs.get(runId) : undefined;
  }

  /**
   * Atomically claims the "active run" slot for `run.migrationName` and, only if the claim
   * succeeds, creates the run record — as a single store call rather than a separate
   * findActiveByName()-then-create() pair. Two reasons that separation would race:
   *
   * 1. Two overlapping callers each awaiting an async read before deciding whether to write
   *    could both see "no active run" before either has written its own claim.
   * 2. Even a single caller doing `await claim(...)` then `await create(...)` leaves a window,
   *    right after the claim resolves and before the run record is actually stored, where a
   *    concurrent findAll()/findById() would see the migration marked active but find no run
   *    for it yet.
   *
   * Both are closed by doing the whole claim-then-create as one call: on the fallback Map path
   * there's no `await` between checking, claiming, and storing, so it happens atomically with
   * respect to the event loop; on the Redis path, the claim (`SET NX`) and the record write
   * happen back-to-back in the same call before any result is returned to the caller.
   */
  async claimAndCreate(run: MigrationRun): Promise<{ claimed: boolean; activeRunId?: string }> {
    if (this.redis) {
      try {
        const claimed = await this.redis.set(this.activeKey(run.migrationName), run.runId, 'NX');
        if (claimed !== 'OK') {
          const activeRunId = await this.redis.get(this.activeKey(run.migrationName));
          return { claimed: false, activeRunId: activeRunId ?? undefined };
        }
        const results = await this.redis
          .multi()
          .set(this.runKey(run.runId), JSON.stringify(run))
          .sadd(RUNS_INDEX_KEY, run.runId)
          .exec();
        this.assertTransactionOk(results);
        return { claimed: true };
      } catch (err) {
        this.logFallback('claimAndCreate', err);
      }
    }

    // No `await` above this line on the fallback path — see the doc comment.
    const existing = this.activeRunByName.get(run.migrationName);
    if (existing) return { claimed: false, activeRunId: existing };
    this.activeRunByName.set(run.migrationName, run.runId);
    this.runs.set(run.runId, run);
    return { claimed: true };
  }

  async markActive(migrationName: string, runId: string): Promise<void> {
    if (this.redis) {
      try {
        await this.redis.set(this.activeKey(migrationName), runId);
        return;
      } catch (err) {
        this.logFallback('markActive', err);
      }
    }

    this.activeRunByName.set(migrationName, runId);
  }

  async clearActive(migrationName: string): Promise<void> {
    if (this.redis) {
      try {
        await this.redis.del(this.activeKey(migrationName));
        return;
      } catch (err) {
        this.logFallback('clearActive', err);
      }
    }

    this.activeRunByName.delete(migrationName);
  }

  private assertTransactionOk(results: Array<[Error | null, unknown]> | null): void {
    if (!results) {
      throw new Error('Redis transaction aborted (exec() returned null, e.g. a WATCH conflict)');
    }
    const failed = results.find(([err]) => err);
    if (failed) {
      throw new Error(`Redis transaction command failed: ${failed[0]!.message}`);
    }
  }

  private runKey(runId: string): string {
    return `${RUN_KEY_PREFIX}${runId}`;
  }

  private activeKey(migrationName: string): string {
    return `${ACTIVE_BY_NAME_PREFIX}${migrationName}`;
  }

  private logFallback(operation: string, err: unknown): void {
    this.metrics?.increment(MIGRATION_STATE_PERSISTENCE_FALLBACK_METRIC, { operation });
    this.logger.error(
      `Redis unavailable for migrationState.${operation}, falling back to per-instance memory ` +
        '(multi-instance state will diverge until Redis recovers)',
      err instanceof Error ? err.stack : String(err),
    );
  }

  private isTerminalState(status: MigrationStatus): boolean {
    return (
      status === MigrationStatus.COMPLETED ||
      status === MigrationStatus.ROLLED_BACK ||
      status === MigrationStatus.FAILED
    );
  }

  /**
   * Prune old runs for a given migration to prevent unbounded growth.
   * Keeps at most MIGRATION_MAX_RUNS_PER_NAME runs per migration name.
   */
  private async pruneOldRuns(migrationName: string): Promise<void> {
    if (!this.redis) return;

    try {
      const allRuns = await this.findAll();
      const runsForMigration = allRuns
        .filter(run => run.migrationName === migrationName && this.isTerminalState(run.status))
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));

      const maxRuns = config.MIGRATION_MAX_RUNS_PER_NAME;
      if (runsForMigration.length > maxRuns) {
        const toDelete = runsForMigration.slice(maxRuns);
        const pipeline = this.redis.pipeline();
        
        for (const run of toDelete) {
          pipeline.del(this.runKey(run.runId));
          pipeline.srem(RUNS_INDEX_KEY, run.runId);
        }

        await pipeline.exec();
        this.logger.log(
          `Pruned ${toDelete.length} old run(s) for migration ${migrationName} ` +
          `(keeping most recent ${maxRuns})`,
        );
      }
    } catch (err) {
      this.logger.warn(`Failed to prune old runs for ${migrationName}: ${err}`);
    }
  }
}
