import { Injectable } from '@nestjs/common';

/**
 * Tracks when event ingestion last successfully talked to the chain, so `/health` can tell a
 * poller that's alive-but-stuck (every attempt silently failing, e.g. bad RPC credentials) from
 * one that's genuinely keeping up — rather than only checking that its process/loop is running
 * (#987).
 *
 * Lives in MonitoringModule (not EventIngestionModule) so `HealthService` can depend on it
 * without MonitoringModule needing to import EventIngestionModule, which already imports
 * MonitoringModule itself and would otherwise create a circular module dependency.
 */
@Injectable()
export class IngestionHealthService {
  private lastSuccessfulPollAt: Date | null = null;
  private pollIntervalMs = 0;

  /** Called by `EventIngestionService` each time it successfully reaches the chain. */
  recordSuccessfulPoll(pollIntervalMs: number): void {
    this.lastSuccessfulPollAt = new Date();
    this.pollIntervalMs = pollIntervalMs;
  }

  getLastSuccessfulPollAt(): Date | null {
    return this.lastSuccessfulPollAt;
  }

  /**
   * Healthy when ingestion has never reported in yet (not configured/not started — not this
   * check's concern, mirrors how `checkDatabase`/`checkRedis` treat "not configured" as
   * healthy) or its last successful poll is within `staleAfterIntervals` poll intervals.
   */
  isHealthy(staleAfterIntervals = 3): boolean {
    if (!this.lastSuccessfulPollAt || !this.pollIntervalMs) return true;
    const age = Date.now() - this.lastSuccessfulPollAt.getTime();
    return age <= this.pollIntervalMs * staleAfterIntervals;
  }
}
