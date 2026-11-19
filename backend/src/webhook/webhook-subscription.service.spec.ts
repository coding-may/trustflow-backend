/**
 * Unit tests for webhook secret rotation grace period (#984).
 *
 * `validateWebhookUrl` is mocked so a local loopback test server is accepted;
 * `computeWebhookSignature` keeps its real HMAC implementation so the
 * dual-signature header produced during a rotation grace period can be
 * verified against both secrets. Subscriptions are created with a dummy
 * `https://` URL to satisfy the DTO schema, then pointed at a plain local
 * HTTP test server (via the service's private store) — `post()` only cares
 * about the `url`'s scheme prefix, and a plain HTTP server keeps these tests
 * independent of TLS/certificate setup in the CI environment.
 */

import * as http from 'http';
import * as crypto from 'crypto';
import { AddressInfo } from 'net';
import { Test, TestingModule } from '@nestjs/testing';
import { WebhookSubscriptionService } from './webhook-subscription.service';
import type { WebhookSubscription } from './webhook-subscription.service';
import { setTestEnv, resetEnvConfig } from '../config/env.config';

jest.mock('./webhook.service', () => {
  const actual: Record<string, unknown> = jest.requireActual('./webhook.service');
  return {
    ...actual,
    validateWebhookUrl: jest.fn().mockResolvedValue(undefined),
  };
});

interface CapturedRequest {
  body: string;
  signature?: string;
}

/** Points an already-created subscription at a plain local HTTP server, bypassing the https-only DTO schema. */
function rewireToLocalServer(service: WebhookSubscriptionService, id: string, url: string): void {
  const subscriptions = (service as unknown as { subscriptions: Map<string, WebhookSubscription> })
    .subscriptions;
  const sub = subscriptions.get(id)!;
  subscriptions.set(id, { ...sub, url });
}

/** Spins up a local HTTP server that records the body and signature header of the last request. */
async function startCapturingServer(): Promise<{
  url: string;
  close: () => Promise<void>;
  last: () => CapturedRequest | undefined;
}> {
  let last: CapturedRequest | undefined;
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', chunk => (raw += chunk));
    req.on('end', () => {
      last = {
        body: raw,
        signature: (req.headers['x-trustflow-signature'] as string) ?? undefined,
      };
      res.writeHead(200).end();
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve, reject) => server.close(e => (e ? reject(e) : resolve()))),
    last: () => last,
  };
}

/** Parses the `t=` timestamp and every `v1=<hex>` entry out of a signature header value. */
function parseSignatureHeader(header: string): { timestampMs: number; signatures: string[] } {
  const parts = header.split(',');
  const timestampMs = Number(parts[0].slice('t='.length));
  const signatures = parts.slice(1).map(part => part.slice('v1='.length));
  return { timestampMs, signatures };
}

function hmac(body: string, secret: string, timestampMs: number): string {
  return crypto.createHmac('sha256', secret).update(`${timestampMs}.${body}`, 'utf8').digest('hex');
}

describe('WebhookSubscriptionService — secret rotation grace period (#984)', () => {
  let service: WebhookSubscriptionService;

  beforeEach(async () => {
    setTestEnv({});
    const module: TestingModule = await Test.createTestingModule({
      providers: [WebhookSubscriptionService],
    }).compile();
    service = module.get(WebhookSubscriptionService);
  });

  afterEach(() => {
    resetEnvConfig();
  });

  it('does not start a grace period when a subscription first gets a secret', async () => {
    const sub = await service.create({
      dappId: 'dapp-1',
      url: 'https://example.com/hook',
      topics: ['*'],
    });

    const updated = await service.update(sub.id, { secret: 'brand-new-secret-16chars' });

    expect(updated.previousSecret).toBeUndefined();
    expect(updated.previousSecretExpiresAt).toBeUndefined();
  });

  it('retains the old secret for a grace period on rotation', async () => {
    const sub = await service.create({
      dappId: 'dapp-1',
      url: 'https://example.com/hook',
      topics: ['*'],
      secret: 'old-secret-value-16chars',
    });

    const before = Date.now();
    const updated = await service.update(sub.id, { secret: 'new-secret-value-16chars' });

    expect(updated.secret).toBe('new-secret-value-16chars');
    expect(updated.previousSecret).toBe('old-secret-value-16chars');
    expect(updated.previousSecretExpiresAt).toBeDefined();
    expect(updated.previousSecretExpiresAt!.getTime()).toBeGreaterThan(before);
  });

  it('does not treat re-saving the same secret as a rotation', async () => {
    const sub = await service.create({
      dappId: 'dapp-1',
      url: 'https://example.com/hook',
      topics: ['*'],
      secret: 'same-secret-value-16chars',
    });

    const updated = await service.update(sub.id, { secret: 'same-secret-value-16chars' });

    expect(updated.previousSecret).toBeUndefined();
  });

  it('dual-signs deliveries with both the old and new secret during the grace period', async () => {
    const { url, close, last } = await startCapturingServer();
    try {
      const oldSecret = 'old-secret-value-16chars';
      const newSecret = 'new-secret-value-16chars';
      const sub = await service.create({
        dappId: 'dapp-1',
        url: 'https://example.com/hook',
        topics: ['*'],
        secret: oldSecret,
      });
      await service.update(sub.id, { secret: newSecret });
      rewireToLocalServer(service, sub.id, url);

      const result = await service.ping(sub.id);
      expect(result.reachable).toBe(true);

      const captured = last();
      expect(captured?.signature).toBeDefined();
      const { timestampMs, signatures } = parseSignatureHeader(captured!.signature!);

      expect(signatures).toHaveLength(2);
      expect(signatures).toContain(hmac(captured!.body, newSecret, timestampMs));
      expect(signatures).toContain(hmac(captured!.body, oldSecret, timestampMs));
    } finally {
      await close();
    }
  });

  it('signs with only the current secret once the grace period elapses, and retires the old one', async () => {
    setTestEnv({ WEBHOOK_SECRET_ROTATION_GRACE_MS: '10' });
    const module: TestingModule = await Test.createTestingModule({
      providers: [WebhookSubscriptionService],
    }).compile();
    const shortGraceService = module.get(WebhookSubscriptionService);

    const { url, close, last } = await startCapturingServer();
    try {
      const oldSecret = 'old-secret-value-16chars';
      const newSecret = 'new-secret-value-16chars';
      const sub = await shortGraceService.create({
        dappId: 'dapp-1',
        url: 'https://example.com/hook',
        topics: ['*'],
        secret: oldSecret,
      });
      await shortGraceService.update(sub.id, { secret: newSecret });
      rewireToLocalServer(shortGraceService, sub.id, url);

      // Wait past the (test-only) 10ms grace period.
      await new Promise(resolve => setTimeout(resolve, 50));

      await shortGraceService.ping(sub.id);

      const captured = last();
      const { timestampMs, signatures } = parseSignatureHeader(captured!.signature!);
      expect(signatures).toEqual([hmac(captured!.body, newSecret, timestampMs)]);

      const stored = shortGraceService.getById(sub.id);
      expect(stored?.previousSecret).toBeUndefined();
      expect(stored?.previousSecretExpiresAt).toBeUndefined();
    } finally {
      await close();
    }
  });
});
