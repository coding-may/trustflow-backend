import {
  Injectable,
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Inject,
  Optional,
} from '@nestjs/common';
import { SanitizedLogger } from '../logging/sanitized-logger';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { Redis, Result } from 'ioredis';
import { randomUUID } from 'crypto';
import { REDIS_CLIENT } from '../redis/redis.module';
import { config, getJwtVerificationSecrets } from '../../config/env.config';
import { MetricsService } from '../../monitoring/metrics.service';
import { RateTier, RATE_LIMIT_TIERS, HIGH_REPUTATION_THRESHOLD } from './rate-tiers';
import './rate-limit.d';

type RateLimitValue = number | (() => number) | undefined;

function resolveLimit(value: RateLimitValue): number | undefined {
  return typeof value === 'function' ? value() : value;
}

/** Keeps enough of an IP/wallet to correlate log lines without writing it out in full. */
export function maskIdentity(value: string): string {
  if (value.length <= 8) return '****';
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}

const DEFAULT_POINTS = 100;
const DEFAULT_DURATION = 60;
/** At most one Redis-error log line per this interval; the rest are only counted. */
const REDIS_ERROR_LOG_INTERVAL_MS = 30_000;
/** `Retry-After` advertised when a `deny` policy rejects a request during a Redis outage. */
const REDIS_ERROR_RETRY_AFTER_SECONDS = 5;

export type RateLimitIdentity = {
  scope: 'ip' | 'wallet';
  value: string;
};

/** Minimal shape of the HTTP request object that rate-limiting reads from. */
interface RateLimitRequest {
  ip?: string;
  method?: string;
  url?: string;
  route?: { path?: string };
  headers?: Record<string, string | string[] | undefined>;
  connection?: { remoteAddress?: string };
  user?: { address?: string; sub?: string };
}

/**
 * Combines the lockout check, token-bucket consume, and (on rejection) abuse recording for
 * a single identity into one atomic round trip — previously three separate Redis commands
 * (`TTL`, `EVAL`, and a second `EVAL` on rejection) run sequentially. Also closes two
 * correctness gaps that came from splitting those steps: the lockout check could no longer
 * race against a lockout applied by another node between the `TTL` read and the bucket
 * consume, and the clock is now `redis.call('TIME')` — the single authoritative clock for
 * every API node — instead of each node's own `Date.now()`, so skewed node clocks no longer
 * produce inconsistent refill/abuse-window math.
 *
 * KEYS[1] = bucket key, KEYS[2] = lockout key, KEYS[3] = abuse key (all three share a
 * `{...}` hash tag over the identity+route so they land on the same Redis Cluster slot —
 * required for this script to run at all once Redis is clustered).
 *
 * ARGV[1] = capacity, ARGV[2] = refill window (ms), ARGV[3] = bucket key TTL (ms),
 * ARGV[4] = abuse window (ms), ARGV[5] = abuse window (seconds, for EXPIRE),
 * ARGV[6] = abuse threshold, ARGV[7] = lockout duration (seconds),
 * ARGV[8] = unique member for this attempt's abuse-window ZSET entry.
 *
 * Returns { allowed: 0 | 1, retryAfter: seconds }.
 */
const RATE_LIMIT_SCRIPT = `
local bucket_key = KEYS[1]
local lockout_key = KEYS[2]
local abuse_key = KEYS[3]

local capacity = tonumber(ARGV[1])
local refill_ms = tonumber(ARGV[2])
local bucket_ttl_ms = tonumber(ARGV[3])
local abuse_window_ms = tonumber(ARGV[4])
local abuse_window_seconds = tonumber(ARGV[5])
local abuse_threshold = tonumber(ARGV[6])
local lockout_seconds = tonumber(ARGV[7])
local member = ARGV[8]

local time = redis.call('TIME')
local now = (tonumber(time[1]) * 1000) + math.floor(tonumber(time[2]) / 1000)

local lockout_pttl = redis.call('PTTL', lockout_key)
if lockout_pttl and lockout_pttl > 0 then
  return {0, math.ceil(lockout_pttl / 1000)}
end

local bucket = redis.call('HMGET', bucket_key, 'tokens', 'updatedAt')
local tokens = tonumber(bucket[1])
local updated_at = tonumber(bucket[2])

if tokens == nil then
  tokens = capacity
  updated_at = now
end

local elapsed = math.max(0, now - updated_at)
tokens = math.min(capacity, tokens + (elapsed * capacity / refill_ms))

if tokens >= 1 then
  tokens = tokens - 1
  redis.call('HSET', bucket_key, 'tokens', tokens, 'updatedAt', now)
  redis.call('PEXPIRE', bucket_key, bucket_ttl_ms)
  return {1, math.floor(tokens)}
end

redis.call('HSET', bucket_key, 'tokens', tokens, 'updatedAt', now)
redis.call('PEXPIRE', bucket_key, bucket_ttl_ms)

local retry_after = math.ceil((1 - tokens) * refill_ms / capacity / 1000)

redis.call('ZREMRANGEBYSCORE', abuse_key, 0, now - abuse_window_ms)
redis.call('ZADD', abuse_key, now, member)
redis.call('EXPIRE', abuse_key, abuse_window_seconds)

local abuse_count = redis.call('ZCARD', abuse_key)
if abuse_count >= abuse_threshold then
  -- Escalate lockout duration for repeat offenders within rolling window (#938)
  local offense_key = KEYS[2] .. ':offenses'
  local offenses = redis.call('INCR', offense_key)
  redis.call('EXPIRE', offense_key, abuse_window_seconds * 2)
  local effective_lockout = lockout_seconds * math.min(offenses, 10)
  redis.call('SET', lockout_key, '1', 'EX', effective_lockout)
  return {0, effective_lockout}
end

return {0, retry_after}
`;

/** Maps a rate tier to its point limit and duration in seconds. */
type RateTierConfig = {
  points: number;
  duration: number;
};

/** Rate tier configurations. */
const RATE_TIER_CONFIGS: Record<string, RateTierConfig> = {
  [RateTier.ANONYMOUS]: { points: 60, duration: 60 },
  [RateTier.AUTHENTICATED]: { points: 300, duration: 60 },
  [RateTier.HIGH_REPUTATION]: { points: 1000, duration: 60 },
};

/** Determines the effective tier config for a request. */
function getTierConfig(
  tier: keyof typeof RATE_LIMIT_TIERS,
  requestedPoints?: number,
  requestedDuration?: number,
): RateTierConfig {
  const config = RATE_TIER_CONFIGS[tier];
  if (!config) return RATE_TIER_CONFIGS[RateTier.ANONYMOUS];
  // If points/duration were explicitly overridden via decorator, use those
  return {
    points: requestedPoints ?? config.points,
    duration: requestedDuration ?? config.duration,
  };
}

/**
 * Rate limiter guard with dynamic tier selection based on authentication status
 * and platform reputation score. Returns RateLimit-* headers on every response.
 */
@Injectable()
export class RateLimitGuard implements CanActivate {
  private readonly logger = new SanitizedLogger(RateLimitGuard.name);
  private readonly reflector: Reflector;

  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis | null,
    private readonly jwtService: JwtService,
    reflector: Reflector,
    @Optional() private readonly metrics?: MetricsService,
    @Optional() private readonly reputationService?: import('../../reputation/reputation.service').ReputationService,
  ) {
    this.reflector = reflector;
    if (this.redis) {
      // Register the Lua script once at startup
      if (typeof this.redis.rateLimitCheck !== 'function') {
        this.redis.defineCommand('rateLimitCheck', { numberOfKeys: 3, lua: RATE_LIMIT_SCRIPT });
      }
    } else {
      // Logged once here, not on every request in canActivate()'s `if (!this.redis) return true`.
      this.logger.warn('Redis not configured — rate limiting disabled');
    }
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const skip = this.reflector.getAllAndOverride<boolean>('skip_rate_limit', [
      context.getHandler(),
      context.getClass(),
    ]);
    if (skip) return true;

    if (!this.redis) return true;

    const request = context.switchToHttp().getRequest();
    const route = this.getRoute(request);
    const identities = this.getIdentities(request);

    // Determine the effective tier for this request
    let tier: keyof typeof RATE_LIMIT_TIERS = RateTier.ANONYMOUS;

    // Check if there's a wallet identity from JWT (authenticated user)
    const wallet = this.extractVerifiedWallet(request);

    if (wallet) {
      // Authenticated user — check reputation score
      try {
        if (this.reputationService) {
          const scoreData = await this.reputationService.getScore(wallet);
          const score = scoreData.score ?? 0;
          if (score >= HIGH_REPUTATION_THRESHOLD) {
            tier = RateTier.HIGH_REPUTATION;
          } else {
            tier = RateTier.AUTHENTICATED;
          }
        } else {
          // No reputation service available, use authenticated tier
          tier = RateTier.AUTHENTICATED;
        }
      } catch (error) {
        this.logger.warn(`Failed to fetch reputation score for wallet ${wallet}: ${error instanceof Error ? error.message : String(error)}`);
        // On reputation service failure, fall back to authenticated tier
        tier = RateTier.AUTHENTICATED;
      }
    } else {
      // Unauthenticated — anonymous tier
      tier = RateTier.ANONYMOUS;
    }

    // Use tier-specific points/duration if not explicitly overridden via decorator
    // Decorator values may be thunks so env-configured limits (e.g. the auth routes) are read
    // at request time rather than when the controller class is first loaded.
    const requestedPoints = resolveLimit(
      this.reflector.getAllAndOverride<RateLimitValue>('rate_limit_points', [
        context.getHandler(),
        context.getClass(),
      ]),
    );
    const requestedDuration = resolveLimit(
      this.reflector.getAllAndOverride<RateLimitValue>('rate_limit_duration', [
        context.getHandler(),
        context.getClass(),
      ]),
    );

    const tierConfig = getTierConfig(
      tier,
      requestedPoints,
      requestedDuration,
    );

    const abuseWindow = config.RATE_LIMIT_ABUSE_WINDOW_SECONDS;
    const abuseThreshold = config.RATE_LIMIT_ABUSE_THRESHOLD;
    const lockoutDuration = config.RATE_LIMIT_LOCKOUT_SECONDS;

    // One pipeline for every identity on this request (at most two: ip, wallet) — one
    // network round trip instead of a sequential TTL+EVAL(+EVAL) per identity.
    const pipeline = this.redis.pipeline();
    for (const identity of identities) {
      const keys = this.buildKeys(identity.scope, identity.value, route);
      pipeline.rateLimitCheck(
        keys.bucket,
        keys.lockout,
        keys.abuse,
        tierConfig.points,
        tierConfig.duration * 1000,
        tierConfig.duration * 2 * 1000,
        abuseWindow * 1000,
        abuseWindow,
        abuseThreshold,
        lockoutDuration,
        randomUUID(),
      );
    }

    // Only Redis failures are caught here. The 429 decision below is made outside the try
    // so a genuine rate-limit rejection is never mistaken for an outage.
    let decisions: Array<[number, number]>;
    try {
      decisions = this.parseResults(
        await this.withTimeout(pipeline.exec(), config.REDIS_COMMAND_TIMEOUT_MS),
        identities.length,
      );
    } catch (error) {
      return this.onRedisError(context, error, identities, route);
    }

    for (let i = 0; i < identities.length; i++) {
      const [allowed, retryAfter] = decisions[i];
      if (Number(allowed) !== 1) {
        const identity = identities[i];
        const retryAfterSeconds = Math.max(1, Math.ceil(Number(retryAfter)));
        const response = context.switchToHttp().getResponse();
        response?.setHeader?.('Retry-After', String(retryAfterSeconds));
        response?.setHeader?.('X-RateLimit-Limit', String(tierConfig.points));
        response?.setHeader?.('X-RateLimit-Remaining', '0');
        response?.setHeader?.('X-RateLimit-Reset', String(retryAfterSeconds));
        this.metrics?.increment('rate_limit_rejections_total', { route, scope: identity.scope });
        this.logger.warn(
          `Rate limit exceeded (scope=${identity.scope}, route=${route}, ` +
            `identity=${maskIdentity(identity.value)}, retryAfter=${retryAfterSeconds}s)`,
        );
        throw new HttpException(
          {
            statusCode: HttpStatus.TOO_MANY_REQUESTS,
            message: 'Too many requests - rate limit exceeded',
            retryAfter: Number(retryAfter),
            scope: `${identity.scope}:${identity.value}`,
          },
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }
    }

    // Response-time headers: set on the response object after the guard passes
    const response = context.switchToHttp().getResponse();
    this.setRateLimitHeaders(response, tier, tierConfig, decisions);

    return true;
  }

  /**
   * Normalises a pipeline reply into one `[allowed, retryAfter]` tuple per identity, throwing
   * when the reply carries a command error or is incomplete/malformed — all of which mean
   * "Redis could not give us a decision" and are handled by the outage policy.
   */
  private parseResults(
    results: Array<[Error | null, unknown]> | null,
    expected: number,
  ): Array<[number, number]> {
    const decisions: Array<[number, number]> = [];
    for (let i = 0; i < expected; i++) {
      const [error, raw] = results?.[i] ?? [new Error('Redis pipeline returned no reply'), null];
      if (error) throw error;
      if (!Array.isArray(raw) || raw.length < 2) {
        throw new Error('Redis rate limit script returned an unexpected reply');
      }
      decisions.push([Number(raw[0]), Number(raw[1])]);
    }
    return decisions;
  }

  /**
   * Belt-and-braces on top of the ioredis `commandTimeout`: the request never waits longer
   * than this for the rate limiter, even if a pipeline is not covered by the client option.
   */
  private withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Redis timed out after ${ms}ms`)), ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
  }

  /**
   * Applies the configured outage policy: `allow` (fail open) lets the request through,
   * `deny` (fail closed) rejects it with 503 + `Retry-After`. The route's
   * metadata wins over the global `RATE_LIMIT_ON_REDIS_ERROR` default. Never surfaces a generic 500.
   */
  private onRedisError(
    context: ExecutionContext,
    error: unknown,
    identities: RateLimitIdentity[],
    route: string,
  ): boolean {
    const isAuthRoute =
      route.startsWith('/auth') ||
      route.startsWith('auth') ||
      route.includes('/auth/') ||
      route.endsWith('/auth');

    const routePolicy = this.reflector.getAllAndOverride<'allow' | 'deny'>('rate_limit_on_redis_error', [
      context.getHandler(),
      context.getClass(),
    ]);

    // /auth/* is hardcoded to deny on Redis outage as an essential security rule.
    // Non-auth routes honor the route override if present, otherwise falling back to RATE_LIMIT_ON_REDIS_ERROR.
    const policy: 'allow' | 'deny' = isAuthRoute
      ? 'deny'
      : (routePolicy ?? config.RATE_LIMIT_ON_REDIS_ERROR ?? 'allow');

    this.metrics?.increment('rate_limit_redis_error_total', { route, policy });
    this.logRedisError(error, identities, route, policy);

    if (policy === 'allow') return true;

    context
      .switchToHttp()
      .getResponse()
      ?.setHeader?.('Retry-After', String(REDIS_ERROR_RETRY_AFTER_SECONDS));
    throw new HttpException(
      {
        statusCode: HttpStatus.SERVICE_UNAVAILABLE,
        message: 'Rate limiting is temporarily unavailable - please retry shortly',
        retryAfter: REDIS_ERROR_RETRY_AFTER_SECONDS,
      },
      HttpStatus.SERVICE_UNAVAILABLE,
    );
  }

  /** Logs at most once per {@link REDIS_ERROR_LOG_INTERVAL_MS}; the metric counts them all. */
  private logRedisError(
    error: unknown,
    identities: RateLimitIdentity[],
    route: string,
    policy: 'allow' | 'deny',
  ): void {
    const now = Date.now();
    if (now - this.lastRedisErrorLogAt < REDIS_ERROR_LOG_INTERVAL_MS) {
      this.suppressedRedisErrors++;
      return;
    }
    const suppressed = this.suppressedRedisErrors;
    this.suppressedRedisErrors = 0;
    this.lastRedisErrorLogAt = now;

    const reason = error instanceof Error ? error.message : String(error);
    const scopes = identities.map(identity => identity.scope).join('+');
    const outcome = policy === 'allow' ? 'allowing request' : 'rejecting request with 503';
    const message =
      `Rate limiter Redis error (scope=${scopes}, route=${route}) — ${outcome}: ${reason}` +
      (suppressed > 0 ? ` [${suppressed} similar errors suppressed]` : '');
    if (policy === 'allow') this.logger.warn(message);
    else this.logger.error(message);
  }

  private getIdentities(request: RateLimitRequest): RateLimitIdentity[] {
    const xForwarded = request.headers?.['x-forwarded-for'];
    const forwarded = Array.isArray(xForwarded) ? xForwarded[0] : xForwarded?.split(',')[0]?.trim();
    const ip = this.normalizeIdentity(
      request.ip || forwarded || request.connection?.remoteAddress || 'unknown',
    );
    const wallet = this.extractVerifiedWallet(request);
    const identities: RateLimitIdentity[] = [{ scope: 'ip', value: ip }];

    if (wallet) {
      identities.push({ scope: 'wallet', value: this.normalizeIdentity(wallet) });
    }

    return identities;
  }

  /**
   * Only a verified wallet identity may select a wallet-scoped bucket. `request.user` is
   * set exclusively by an already-verified auth strategy — but this guard is registered
   * globally and therefore runs before route-level guards like JwtAuthGuard, so
   * `request.user` is not populated yet on authenticated routes. Verify the bearer token
   * here instead of trusting it. Caller-controlled body/query/param fields are never
   * consulted: an unverified value would let a client rotate identities to dodge limits.
   */
  private extractVerifiedWallet(request: RateLimitRequest): string | undefined {
    const verifiedAddress = request.user?.address || request.user?.sub;
    if (verifiedAddress) {
      return verifiedAddress;
    }

    const token = this.extractBearerToken(request);
    if (!token) {
      return undefined;
    }

    const verificationSecrets = getJwtVerificationSecrets();

    for (const secret of verificationSecrets) {
      try {
        const payload = this.jwtService.verify<{ address?: string; sub?: string }>(token, {
          secret,
        });
        return payload.address || payload.sub;
      } catch {
        // Fall through to the next active secret during a key rotation overlap.
      }
    }

    return undefined;
  }

  private extractBearerToken(request: RateLimitRequest): string | undefined {
    const header = request.headers?.authorization;
    const value = Array.isArray(header) ? header[0] : header;
    if (!value || !value.startsWith('Bearer ')) {
      return undefined;
    }
    const token = value.slice('Bearer '.length).trim();
    return token || undefined;
  }

  private getRoute(request: RateLimitRequest): string {
    const method = request.method || 'GET';
    const route = request.route?.path || request.url || '/';
    return this.normalizeIdentity(`${method}:${route}`);
  }

  /**
   * All three keys for one identity share a `{...}` hash tag over scope+identity+route, so
   * Redis Cluster maps them to the same slot — required for the combined Lua script (which
   * touches all three) to run at all once Redis is clustered.
   */
  private buildKeys(
    scope: string,
    identity: string,
    route: string,
  ): { bucket: string; lockout: string; abuse: string } {
    const network = (config.STELLAR_NETWORK || 'testnet').toLowerCase();
    const tag = scope === 'wallet'
      ? `${scope}:${network}:${identity}:${route}`
      : `${scope}:${identity}:${route}`;
    return {
      bucket: `ratelimit:{${tag}}:bucket`,
      lockout: `ratelimit:{${tag}}:lockout`,
      abuse: `ratelimit:{${tag}}:abuse`,
    };
  }

  private normalizeIdentity(value: string): string {
    return String(value)
      .toLowerCase()
      .replace(/[^a-z0-9:._-]/g, '_');
  }

  // Instance state for error logging suppression
  private lastRedisErrorLogAt = 0;
  private suppressedRedisErrors = 0;

  /**
   * Sets RateLimit-* headers on the response based on the tier and bucket state.
   * With multiple identities per request (e.g. IP + wallet), the tighter (lower-remaining)
   * decision drives the advertised headers so the client paces itself against whichever
   * bucket is closer to exhaustion.
   */
  private setRateLimitHeaders(
    response: any,
    tier: keyof typeof RATE_LIMIT_TIERS,
    tierConfigOrDecisions: RateTierConfig | Array<[number, number]>,
    maybeDecisions?: Array<[number, number]>,
  ): void {
    let tierConfig: RateTierConfig;
    let decisions: Array<[number, number]>;

    if (Array.isArray(tierConfigOrDecisions)) {
      decisions = tierConfigOrDecisions;
      tierConfig = RATE_TIER_CONFIGS[tier] ?? { points: DEFAULT_POINTS, duration: DEFAULT_DURATION };
    } else {
      tierConfig = tierConfigOrDecisions ?? RATE_TIER_CONFIGS[tier] ?? { points: DEFAULT_POINTS, duration: DEFAULT_DURATION };
      decisions = maybeDecisions ?? [];
    }

    if (!tierConfig || !response?.setHeader) return;

    let minRemaining = tierConfig.points;
    let maxReset = 0;

    if (decisions && decisions.length > 0) {
      for (const [allowed, value] of decisions) {
        if (allowed === 1) {
          // When allowed, the Lua script returns the remaining tokens in the bucket.
          // Pick the tighter (lower remaining) of all identities.
          const remaining = Math.max(0, value);
          if (remaining < minRemaining) {
            minRemaining = remaining;
          }
        } else {
          // When rejected, remaining is 0 and value is the retryAfter in seconds.
          minRemaining = 0;
          if (value > maxReset) {
            maxReset = value;
          }
        }
      }
    } else {
      minRemaining = Math.max(0, tierConfig.points - 1);
    }

    response.setHeader('RateLimit-Limit', String(tierConfig.points));
    response.setHeader('RateLimit-Remaining', String(minRemaining));
    response.setHeader('RateLimit-Reset', String(Math.ceil(maxReset)));

    this.logger.debug(
      `Rate limit headers set — tier: ${tier}, limit: ${tierConfig.points}, remaining: ${minRemaining}, reset: ${Math.ceil(maxReset)}s`,
    );
  }
}