import { Injectable, NotFoundException } from '@nestjs/common';
import * as http from 'http';
import * as https from 'https';
import { v4 as uuidv4 } from 'uuid';
import { SanitizedLogger } from '../common/logging/sanitized-logger';
import { computeWebhookSignature, validateWebhookUrl } from './webhook.service';
import { config } from '../config/env.config';
import {
  CreateWebhookSubscriptionSchema,
  UpdateWebhookSubscriptionSchema,
} from './webhook-subscription.dto';
import type {
  CreateWebhookSubscriptionDto,
  UpdateWebhookSubscriptionDto,
} from './webhook-subscription.dto';

/** Internal subscription record — the raw secret is retained for request signing. */
export interface WebhookSubscription {
  id: string;
  dappId: string;
  url: string;
  topics: string[];
  /** HMAC-SHA256 secret used to sign outbound payloads. Never exposed in API responses. */
  secret?: string;
  /**
   * Secret that was replaced by `secret` in the most recent rotation (#984).
   * Kept around, and dual-signed alongside the new secret, until
   * `previousSecretExpiresAt` passes — so deliveries in flight when the
   * rotation happened don't fail verification before the subscriber has
   * migrated to the new secret.
   */
  previousSecret?: string;
  /** When `previousSecret` stops being accepted and is fully retired. */
  previousSecretExpiresAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

/** Result of a ping probe against a subscription endpoint. */
export interface WebhookSubscriptionPingResult {
  /** True when the endpoint responded with a 2xx status. */
  reachable: boolean;
  /** Round-trip time in milliseconds. */
  responseTimeMs: number;
  /** HTTP status code returned by the endpoint, when a response was received. */
  statusCode?: number;
}

/** Timeout for ping probes. */
const PING_TIMEOUT_MS = 5_000;

/**
 * In-memory store for webhook subscriptions.
 *
 * Subscriptions are keyed by their UUID. The store is process-local: it is
 * intended for development, testing, and single-instance deployments. A
 * persistent implementation should back this with the database while keeping
 * the same method signatures.
 */
@Injectable()
export class WebhookSubscriptionService {
  private readonly logger = new SanitizedLogger(WebhookSubscriptionService.name);
  private readonly subscriptions = new Map<string, WebhookSubscription>();

  /**
   * Create a subscription. The URL must be https and must not resolve to a
   * private address (validated via {@link validateWebhookUrl}).
   */
  async create(dto: CreateWebhookSubscriptionDto): Promise<WebhookSubscription> {
    const data = CreateWebhookSubscriptionSchema.parse(dto);
    await validateWebhookUrl(data.url);

    const subscription: WebhookSubscription = {
      id: uuidv4(),
      dappId: data.dappId,
      url: data.url,
      topics: data.topics,
      ...(data.secret !== undefined ? { secret: data.secret } : {}),
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    this.subscriptions.set(subscription.id, subscription);
    this.logger.log(`Created webhook subscription ${subscription.id} for dApp ${data.dappId}`);
    return subscription;
  }

  /** List every subscription belonging to `dappId`, newest first. */
  listByDapp(dappId: string): WebhookSubscription[] {
    return Array.from(this.subscriptions.values())
      .filter(s => s.dappId === dappId)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  }

  /** Fetch a single subscription by ID, or undefined when it does not exist. */
  getById(id: string): WebhookSubscription | undefined {
    return this.subscriptions.get(id);
  }

  /** Partially update a subscription. At least one field must be provided. */
  async update(
    id: string,
    dto: UpdateWebhookSubscriptionDto,
  ): Promise<WebhookSubscription> {
    const data = UpdateWebhookSubscriptionSchema.parse(dto);

    const existing = this.subscriptions.get(id);
    if (!existing) {
      throw new NotFoundException(`Webhook subscription ${id} not found`);
    }
    if (data.url !== undefined) await validateWebhookUrl(data.url);

    // A rotation is a *change* of an existing secret, not its first set — a brand new
    // subscription (or one that had no secret yet) has nothing worth a grace period for (#984).
    const isRotation =
      data.secret !== undefined && existing.secret !== undefined && data.secret !== existing.secret;

    const updated: WebhookSubscription = {
      ...existing,
      ...(data.dappId !== undefined ? { dappId: data.dappId } : {}),
      ...(data.url !== undefined ? { url: data.url } : {}),
      ...(data.topics !== undefined ? { topics: data.topics } : {}),
      ...(data.secret !== undefined ? { secret: data.secret } : {}),
      ...(isRotation
        ? {
            previousSecret: existing.secret,
            previousSecretExpiresAt: new Date(Date.now() + config.WEBHOOK_SECRET_ROTATION_GRACE_MS),
          }
        : {}),
      updatedAt: new Date(),
    };
    this.subscriptions.set(id, updated);
    if (isRotation) {
      this.logger.log(
        `Rotated signing secret for webhook subscription ${id}; previous secret still accepted ` +
          `until ${updated.previousSecretExpiresAt!.toISOString()}`,
      );
    } else {
      this.logger.log(`Updated webhook subscription ${id}`);
    }
    return updated;
  }

  /** Delete a subscription. Returns true when a record was removed. */
  remove(id: string): boolean {
    const removed = this.subscriptions.delete(id);
    if (removed) this.logger.log(`Deleted webhook subscription ${id}`);
    return removed;
  }

  /**
   * Probe the subscription endpoint with a signed test POST and report
   * reachability. Resolves (never throws for network failures) with
   * `reachable: false` when the endpoint errors or times out.
   */
  async ping(id: string): Promise<WebhookSubscriptionPingResult> {
    const subscription = this.subscriptions.get(id);
    if (!subscription) {
      throw new NotFoundException(`Webhook subscription ${id} not found`);
    }

    // Re-validate URL at dispatch time to protect against DNS rebinding
    try {
      await validateWebhookUrl(subscription.url);
    } catch (err) {
      this.logger.warn(
        `Ping to subscription ${id} rejected due to blocked/private URL: ${err instanceof Error ? err.message : String(err)}`,
      );
      return { reachable: false, responseTimeMs: 0 };
    }

    const payload = JSON.stringify({
      type: 'ping',
      timestamp: new Date().toISOString(),
      subscriptionId: id,
    });

    const startedAt = Date.now();
    try {
      const statusCode = await this.post(
        subscription.url,
        payload,
        subscription.secret,
        this.activePreviousSecret(subscription),
      );
      return {
        reachable: statusCode >= 200 && statusCode < 300,
        responseTimeMs: Date.now() - startedAt,
        statusCode,
      };
    } catch (err) {
      this.logger.warn(
        `Ping to subscription ${id} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return { reachable: false, responseTimeMs: Date.now() - startedAt };
    }
  }

  /**
   * Returns `previousSecret` only while it is still within its rotation grace
   * period; once `previousSecretExpiresAt` has passed it is fully retired —
   * cleared from the record so it is never considered again (#984).
   */
  private activePreviousSecret(subscription: WebhookSubscription): string | undefined {
    if (!subscription.previousSecret || !subscription.previousSecretExpiresAt) {
      return undefined;
    }
    if (subscription.previousSecretExpiresAt.getTime() <= Date.now()) {
      const retired: WebhookSubscription = { ...subscription };
      delete retired.previousSecret;
      delete retired.previousSecretExpiresAt;
      this.subscriptions.set(subscription.id, retired);
      return undefined;
    }
    return subscription.previousSecret;
  }

  /**
   * Fire a single POST at the subscription URL and resolve with the response
   * status code. Rejects on transport error or timeout.
   *
   * When `previousSecret` is supplied (an active rotation grace period, #984),
   * the request carries one `v1=` signature per secret under a shared `t=`
   * timestamp, so a receiver verifying against either the old or the new
   * secret accepts the delivery.
   */
  private post(
    url: string,
    body: string,
    secret?: string,
    previousSecret?: string,
  ): Promise<number> {
    return new Promise((resolve, reject) => {
      const transport = url.startsWith('https') ? https : http;
      const headers: Record<string, string | number> = {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body, 'utf8'),
      };
      if (secret) {
        headers['X-TrustFlow-Signature'] = previousSecret
          ? this.dualSign(body, secret, previousSecret)
          : computeWebhookSignature(body, secret);
      }

      const req = transport.request(
        url,
        { method: 'POST', headers },
        res => {
          res.resume(); // drain the body so the socket can close cleanly
          resolve(res.statusCode ?? 0);
        },
      );
      req.setTimeout(PING_TIMEOUT_MS, () => {
        req.destroy(new Error(`Ping timed out after ${PING_TIMEOUT_MS}ms`));
      });
      req.on('error', reject);
      req.write(body);
      req.end();
    });
  }

  /**
   * Builds an `X-TrustFlow-Signature` header carrying one `v1=` signature per
   * secret, all computed over the same shared timestamp so a receiver can
   * verify against whichever of the two secrets it currently holds (#984):
   *
   *   t=<ms>,v1=<hmac_with_new_secret>,v1=<hmac_with_previous_secret>
   */
  private dualSign(body: string, secret: string, previousSecret: string): string {
    const timestampMs = Date.now();
    const current = computeWebhookSignature(body, secret, timestampMs);
    const previousHex = computeWebhookSignature(body, previousSecret, timestampMs).split('v1=')[1];
    return `${current},v1=${previousHex}`;
  }
}
