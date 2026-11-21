import { Injectable } from '@nestjs/common';
import * as https from 'https';
import { BaseHttpPinProvider } from './base-http-pin.provider';
import { PinProviderName } from './ipfs-provider.interface';
import { buildSingleFileMultipart } from './multipart.util';
import { config } from '../../config/env.config';
import { RateLimitError } from './rate-limit-error';

const INFURA_IPFS_HOST = 'ipfs.infura.io';
const INFURA_IPFS_PORT = 5001;

/**
 * Infura IPFS adapter, speaking the standard Kubo HTTP RPC API. Configured via the
 * INFURA_IPFS_PROJECT_ID and INFURA_IPFS_PROJECT_SECRET env vars (basic auth).
 * Falls back to simulated in-memory pinning when unset — see BaseHttpPinProvider.
 * Uploads request cid-version=1 with raw-leaves so the node-assigned CID matches
 * our locally computed content hash for single-block payloads.
 */
@Injectable()
export class InfuraProvider extends BaseHttpPinProvider {
  readonly name = PinProviderName.INFURA;

  protected get credential(): string | undefined {
    const projectId = config.INFURA_IPFS_PROJECT_ID;
    const secret = config.INFURA_IPFS_PROJECT_SECRET;
    return projectId && secret ? `${projectId}:${secret}` : undefined;
  }

  protected async sendPin(cid: string, content: Buffer, credential: string): Promise<void> {
    const { body, contentType } = buildSingleFileMultipart('file', cid, content);

    const response = await this.request<{ Hash: string }>(credential, {
      path: '/api/v0/add?pin=true&cid-version=1&raw-leaves=true',
      method: 'POST',
      headers: { 'Content-Type': contentType, 'Content-Length': body.length },
      body,
    });

    if (response.Hash !== cid) {
      throw new Error(
        `Infura returned CID ${response.Hash}, which does not match the expected content hash ${cid}`,
      );
    }
  }

  protected async sendUnpin(cid: string, credential: string): Promise<void> {
    await this.request(credential, {
      path: `/api/v0/pin/rm?arg=${cid}`,
      method: 'POST',
      headers: {},
    });
  }

  protected async sendVerify(cid: string, credential: string): Promise<boolean> {
    try {
      await this.request(credential, {
        path: `/api/v0/pin/ls?arg=${cid}&type=recursive`,
        method: 'POST',
        headers: {},
      });
      return true;
    } catch {
      return false;
    }
  }

  private parseRetryAfter(header: string | string[] | undefined): number | undefined {
    if (!header || Array.isArray(header)) return undefined;
    const seconds = parseInt(header, 10);
    return Number.isFinite(seconds) ? seconds : undefined;
  }

  private request<T = void>(
    credential: string,
    options: {
      path: string;
      method: string;
      headers: Record<string, string | number>;
      body?: Buffer;
    },
  ): Promise<T> {
    return new Promise((resolve, reject) => {
      const auth = Buffer.from(credential).toString('base64');
      const req = https.request(
        {
          hostname: INFURA_IPFS_HOST,
          port: INFURA_IPFS_PORT,
          path: options.path,
          method: options.method,
          headers: { ...options.headers, Authorization: `Basic ${auth}` },
        },
        res => {
          const chunks: Buffer[] = [];
          res.on('data', chunk => chunks.push(chunk));
          res.on('end', () => {
            if (!res.statusCode) {
              reject(new Error('Infura request returned no status code'));
              return;
            }
            if (res.statusCode === 429) {
              const retryAfter = this.parseRetryAfter(res.headers['retry-after']);
              reject(new RateLimitError('Infura', retryAfter));
              return;
            }
            if (res.statusCode >= 400) {
              reject(new Error(`Infura request failed with status ${res.statusCode}`));
              return;
            }
            const raw = Buffer.concat(chunks).toString('utf8');
            resolve((raw ? JSON.parse(raw.split('\n')[0]) : undefined) as T);
          });
        },
      );
      req.on('error', reject);
      if (options.body) req.write(options.body);
      req.end();
    });
  }
}
