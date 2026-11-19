import { rpc as SorobanRpc, Transaction, Networks } from '@stellar/stellar-sdk';
import { config } from '../config/env.config';

export function buildSorobanServer(url: string): SorobanRpc.Server {
  return new SorobanRpc.Server(url, {
    timeout: config.STELLAR_RPC_TIMEOUT_MS,
  });
}

export async function simulateTransaction(
  rpcUrl: string,
  xdr: string,
): Promise<SorobanRpc.Api.SimulateTransactionResponse> {
  return withSorobanFailover(async endpoint => {
    const server = buildSorobanServer(endpoint);
    const tx = new Transaction(xdr, Networks.TESTNET);
    return server.simulateTransaction(tx);
  }, rpcUrl);
}

export function isSimulationError(
  result: SorobanRpc.Api.SimulateTransactionResponse,
): result is SorobanRpc.Api.SimulateTransactionErrorResponse {
  return false;
}

/**
 * Thrown by `withSorobanFailover` when the underlying error is a permanent
 * configuration mistake (e.g. the RPC endpoint points at the wrong network
 * for the given account) rather than a transient RPC/network failure.
 * Retrying this across endpoints only delays the actionable signal (#986).
 */
export class SorobanConfigurationError extends Error {
  constructor(public readonly cause: Error) {
    super(`Soroban configuration error (not retrying): ${cause.message}`);
    this.name = 'SorobanConfigurationError';
  }
}

/**
 * Whether a Soroban RPC error is a permanent configuration mistake rather
 * than a transient failure worth retrying.
 *
 * `Server#getAccount` rejects with `{ code: 404, message: "Account not
 * found: <address>" }` when the configured RPC endpoint is on a different
 * network than the account (or the account genuinely doesn't exist) — that
 * won't resolve itself by retrying the same request against another
 * endpoint. Similarly, a network passphrase mismatch always fails the same
 * way on every attempt (#986).
 */
export function isNonRetryableSorobanError(error: unknown): boolean {
  const e = error as { code?: number; message?: string };
  const message = e?.message ?? (error instanceof Error ? error.message : String(error ?? ''));

  if (e?.code === 404 && /account not found/i.test(message)) {
    return true;
  }

  return /account not found|invalid network passphrase/i.test(message);
}

export async function withSorobanFailover<T>(
  operation: (endpoint: string) => Promise<T>,
  primaryEndpoint?: string,
  maxRetries: number = 2,
): Promise<T> {
  let lastError: Error | undefined;

  // Get endpoints from config or use provided primary
  const endpoints = primaryEndpoint
    ? [
        primaryEndpoint,
        ...(config.SOROBAN_RPC_ENDPOINTS || '')
          .split(',')
          .filter(Boolean)
          .map((url: string) => url.trim()),
      ]
    : config.SOROBAN_RPC_URL!.split(',').map((url: string) => url.trim());

  // Remove duplicates
  const uniqueEndpoints = [...new Set(endpoints.filter(Boolean))];

  for (let attempt = 0; attempt < maxRetries + 1; attempt++) {
    const endpointIndex = attempt % uniqueEndpoints.length;
    const endpoint = uniqueEndpoints[endpointIndex];

    try {
      return await operation(endpoint);
    } catch (error) {
      const err = error as Error;

      // A permanent configuration mistake is a definitive answer, not a
      // transport failure — don't burn the retry budget on it (#986).
      if (isNonRetryableSorobanError(error)) {
        throw new SorobanConfigurationError(err);
      }

      lastError = err;

      if (attempt < maxRetries) {
        // If this wasn't the last attempt, wait a bit before retrying with next endpoint
        await new Promise(resolve => setTimeout(resolve, 100 * (attempt + 1)));
      }
    }
  }

  throw lastError || new Error('Soroban operation failed after all retry attempts');
}
