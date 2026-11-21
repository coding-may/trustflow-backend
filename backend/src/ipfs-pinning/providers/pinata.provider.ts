import { Injectable } from '@nestjs/common';
import * as https from 'https';
import { BaseHttpPinProvider } from './base-http-pin.provider';
import { PinProviderName } from './ipfs-provider.interface';
import { buildSingleFileMultipart } from './multipart.util';
import { config } from '../../config/env.config';
import { RateLimitError } from './rate-limit-error';

const PINATA_API_HOST = 'api.pinata.cloud';

/**
 * Pinata (https://pinata.cloud) adapter. Configured via the IPFS_PINATA_JWT env var
 * (a Pinata API JWT with pinning scope). Falls back to simulated in-memory
 * pinning when unset — see BaseHttpPinProvider.
 *
 * HTTP requests to Pinata timeout after IPFS_PROVIDER_TIMEOUT_MS (default 30s) to prevent
 * hung requests from blocking the sweep (#409).
 */
@Injectable()
export class PinataProvider extends BaseHttpPinProvider {
  readonly name = PinProviderName.PINATA;

  protected get credential(): string | undefined {
    return config.PINATA_JWT || undefined;
  }

  protected async sendPin(cid: string, content: Buffer, jwt: string): Promise<void> {
    const { body, contentType } = buildSingleFileMultipart('file', cid, content);

    const response = await this.request<{ IpfsHash: string }>({
      hostname: PINATA_API_HOST,
      path: '/pinning/pinFileToIPFS',
      method: 'POST',
      headers: {
        Authorization: `Bearer ${jwt}`,
        'Content-Type': contentType,
        'Content-Length': body.length,
      },
      body,
    });

    if (response.IpfsHash !== cid) {
      throw new Error(
        `Pinata returned CID ${response.IpfsHash}, which does not match the expected content hash ${cid}`,
      );
    }
  }

  protected async sendUnpin(cid: string, jwt: string): Promise<void> {
    await this.request({
      hostname: PINATA_API_HOST,
      path: `/pinning/unpin/${cid}`,
      method: 'DELETE',
      headers: { Authorization: `Bearer ${jwt}` },
    });
  }

  protected async sendVerify(cid: string, jwt: string): Promise<boolean> {
    const response = await this.request<{ rows: unknown[] }>({
      hostname: PINATA_API_HOST,
      path: `/data/pinList?hashContains=${cid}&status=pinned`,
      method: 'GET',
      headers: { Authorization: `Bearer ${jwt}` },
    });
    return response.rows.length > 0;
  }

  private parseRetryAfter(header: string | string[] | undefined): number | undefined {
    if (!header || Array.isArray(header)) return undefined;
    const seconds = parseInt(header, 10);
    return Number.isFinite(seconds) ? seconds : undefined;
  }

  private request<T = void>(options: {
    hostname: string;
    path: string;
    method: string;
    headers: Record<string, string | number>;
    body?: Buffer;
  }): Promise<T> {
    return new Promise((resolve, reject) => {
      const timeoutMs = config.IPFS_PROVIDER_TIMEOUT_MS;
      const req = https.request(
        {
          hostname: options.hostname,
          path: options.path,
          method: options.method,
          headers: options.headers,
          timeout: timeoutMs,
        },
        res => {
          const chunks: Buffer[] = [];
          res.on('data', chunk => chunks.push(chunk));
          res.on('end', () => {
            if (!res.statusCode) {
              reject(new Error('Pinata request returned no status code'));
              return;
            }
            if (res.statusCode === 429) {
              const retryAfter = this.parseRetryAfter(res.headers['retry-after']);
              reject(new RateLimitError('Pinata', retryAfter));
              return;
            }
            if (res.statusCode >= 400) {
              reject(new Error(`Pinata request failed with status ${res.statusCode}`));
              return;
            }
            const raw = Buffer.concat(chunks).toString('utf8');
            resolve((raw ? JSON.parse(raw) : undefined) as T);
          });
        },
      );
      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy();
        reject(new Error(`Pinata request timed out after ${timeoutMs}ms`));
      });
      if (options.body) req.write(options.body);
      req.end();
    });
  }
}
