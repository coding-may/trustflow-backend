import { Injectable } from '@nestjs/common';
import { SanitizedLogger } from '../common/logging/sanitized-logger';
import { MetricsService } from './metrics.service';

const SLOW_QUERY_THRESHOLD_MS = 200;

/**
 * Monitors database query execution time and emits metrics/logs for slow queries.
 * Implements requirements from issue #677: log queries exceeding 200ms and emit
 * Prometheus histogram metrics for query duration percentiles (p50, p95, p99).
 */
@Injectable()
export class DatabaseQueryLoggerService {
  private readonly logger = new SanitizedLogger(DatabaseQueryLoggerService.name);

  constructor(private readonly metrics: MetricsService) {
    // Register histogram with buckets optimized for database query durations
    this.metrics.registerHistogram(
      'database_query_duration_seconds',
      'Database query execution time distribution in seconds',
      [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.2, 0.5, 1, 2, 5],
      {},
    );
  }

  /**
   * Log query execution and emit metrics.
   * @param query - SQL query text (will be sanitized for logging)
   * @param durationMs - Query execution duration in milliseconds
   * @param poolLabel - Pool identifier (primary/replica)
   */
  logQuery(query: string, durationMs: number, poolLabel: string): void {
    // Always emit histogram metric for percentile calculation
    this.metrics.observeHistogramMs(
      'database_query_duration_seconds',
      durationMs,
      { pool: poolLabel },
    );

    // Log warning for slow queries
    if (durationMs > SLOW_QUERY_THRESHOLD_MS) {
      const sanitizedQuery = this.sanitizeQuery(query);
      this.logger.warn(
        `Slow query detected [${poolLabel}]: ${durationMs.toFixed(2)}ms\n` +
          `Query: ${sanitizedQuery}`,
      );
      this.metrics.increment('database_slow_queries_total', { pool: poolLabel });
    }
  }

  /**
   * Sanitize query string for safe logging by:
   * - Replacing string literals with placeholders
   * - Replacing numeric literals with placeholders  
   * - Truncating to reasonable length
   */
  private sanitizeQuery(query: string): string {
    const sanitized = query
      .replace(/'(?:[^']|'')*'/g, '?') // String literals
      .replace(/\b\d+\.\d+\b/g, '?') // Decimal numbers
      .replace(/\b\d+\b/g, '?') // Integers
      .replace(/\$\d+/g, '?') // Parameterized placeholders
      .replace(/\s+/g, ' ') // Normalize whitespace
      .trim();

    return sanitized.length > 500 ? `${sanitized.slice(0, 500)}...` : sanitized;
  }
}
