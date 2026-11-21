import { Injectable } from '@nestjs/common';
import * as https from 'https';
import { BaseHttpPinProvider } from './base-http-pin.provider';
import { PinProviderName } from './ipfs-provider.interface';
import { config } from '../../config/env.config';
import { RateLimitError } from './rate-limit-error';

const WEB3_STORAGE_API_HOST = 'api.web3.storage';

/**
 * web3.storage adapter. Configured via the WEB3_STORAGE_TOKEN env var (an API token
 * with upload scope). Falls back to simulated in-memory pinning when unset — see
 * BaseHttpPinProvider. Unlike Pinata, web3.storage's /upload endpoint accepts the
 * raw file bytes directly rather than multipart/form-data.
 */
@Injectable()
export class Web3StorageProvider extends BaseHttpPinProvider {
  readonly name = PinProviderName.WEB3_STORAGE;

  protected get credential(): string | undefined {
    return config.WEB3_STORAGE_TOKEN || undefined;
  }

  protected async sendPin(cid: string, content: Buffer, token: string): Promise<void> {
    const response = await this.request<{ cid: string }>({
      path: '/upload',
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/octet-stream',
        'Content-Length': content.length,
      },
      body: content,
    });

    if (response.cid !== cid) {
      throw new Error(
        `web3.storage returned CID ${response.cid}, which does not match the expected content hash ${cid}`,
      );
    }
  }

  protected async sendUnpin(cid: string, token: string): Promise<void> {
    await this.request({
      path: `/user/uploads/${cid}`,
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    });
  }

  protected async sendVerify(cid: string, token: string): Promise<boolean> {
    try {
      await this.request({
        path: `/status/${cid}`,
        method: 'GET',
        headers: { Authorization: `Bearer ${token}` },
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

  private request<T = void>(options: {
    path: string;
    method: string;
    headers: Record<string, string | number>;
    body?: Buffer;
  }): Promise<T> {
    return new Promise((resolve, reject) => {
      const req = https.request(
        {
          hostname: WEB3_STORAGE_API_HOST,
          path: options.path,
          method: options.method,
          headers: options.headers,
        },
        res => {
          const chunks: Buffer[] = [];
          res.on('data', chunk => chunks.push(chunk));
          res.on('end', () => {
            if (!res.statusCode) {
              reject(new Error('web3.storage request returned no status code'));
              return;
            }
            if (res.statusCode === 429) {
              const retryAfter = this.parseRetryAfter(res.headers['retry-after']);
              reject(new RateLimitError('web3.storage', retryAfter));
              return;
            }
            if (res.statusCode >= 400) {
              reject(new Error(`web3.storage request failed with status ${res.statusCode}`));
              return;
            }
            const raw = Buffer.concat(chunks).toString('utf8');
            resolve((raw ? JSON.parse(raw) : undefined) as T);
          });
        },
      );
      req.on('error', reject);
      if (options.body) req.write(options.body);
      req.end();
    });
  }
}
