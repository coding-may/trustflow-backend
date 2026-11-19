import { validateEnv } from '../config/env.config';

// withSorobanFailover reads config.SOROBAN_RPC_ENDPOINTS, which requires validateEnv()
// to have already run — normally done once in main.ts (see rpc-failover.service.spec.ts).
validateEnv();

import {
  withSorobanFailover,
  isNonRetryableSorobanError,
  SorobanConfigurationError,
} from './soroban.helper';

describe('isNonRetryableSorobanError', () => {
  it('flags a getAccount-style 404 "Account not found" rejection as non-retryable', () => {
    expect(isNonRetryableSorobanError({ code: 404, message: 'Account not found: GADDR' })).toBe(
      true,
    );
  });

  it('flags an "Account not found" Error as non-retryable', () => {
    expect(isNonRetryableSorobanError(new Error('Account not found: GADDR'))).toBe(true);
  });

  it('flags an invalid network passphrase error as non-retryable', () => {
    expect(isNonRetryableSorobanError(new Error('Invalid network passphrase'))).toBe(true);
  });

  it('does not flag a transient network error as non-retryable', () => {
    expect(isNonRetryableSorobanError(new Error('ETIMEDOUT'))).toBe(false);
  });

  it('does not flag a generic 5xx-style error as non-retryable', () => {
    expect(isNonRetryableSorobanError({ code: 503, message: 'Service Unavailable' })).toBe(false);
  });
});

describe('withSorobanFailover', () => {
  it('fails fast on a permanent "account not found" error without exhausting retries', async () => {
    const operation = jest
      .fn()
      .mockRejectedValue({ code: 404, message: 'Account not found: GADDR' });

    await expect(
      withSorobanFailover(operation, 'https://rpc-one.example', 2),
    ).rejects.toBeInstanceOf(SorobanConfigurationError);

    // Only the first attempt should run — no retries burned on a config error.
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it('retries a transient error across endpoints before giving up', async () => {
    const operation = jest
      .fn()
      .mockRejectedValueOnce(new Error('ECONNRESET'))
      .mockResolvedValueOnce('ok');

    const result = await withSorobanFailover(operation, 'https://rpc-one.example', 2);

    expect(result).toBe('ok');
    expect(operation).toHaveBeenCalledTimes(2);
  });

  it('throws the last transient error once all retries are exhausted', async () => {
    const operation = jest.fn().mockRejectedValue(new Error('ETIMEDOUT'));

    await expect(withSorobanFailover(operation, 'https://rpc-one.example', 2)).rejects.toThrow(
      'ETIMEDOUT',
    );
    expect(operation).toHaveBeenCalledTimes(3);
  });
});
