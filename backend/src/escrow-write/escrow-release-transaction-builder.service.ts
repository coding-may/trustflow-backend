import { Inject, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { SanitizedLogger } from '../common/logging/sanitized-logger';
import {
  rpc as SorobanRpc,
  Contract,
  TransactionBuilder,
  BASE_FEE,
  nativeToScVal,
} from '@stellar/stellar-sdk';
import { StellarConfig } from '../stellar/stellar.config';
import { config } from '../config/env.config';

export const SOROBAN_RPC_SERVER = 'SOROBAN_RPC_SERVER';
export const ESCROW_WRITE_STELLAR_CONFIG = 'ESCROW_WRITE_STELLAR_CONFIG';

/**
 * Assumed entrypoint for the non-disputed release call: a single string argument, the
 * contract's own escrow id. Not yet verified against a real contract — see the #180 spike
 * write-up (backend/ESCROW_WRITE_PATH_SPIKE.md) for why. Update this if the confirmed
 * contract signature turns out to differ.
 */
const RELEASE_ENTRYPOINT = 'release';

/**
 * Headroom applied to the RPC's `minResourceFee` before it becomes the transaction fee.
 * Soroban resource prices can drift between simulation and submission, so a small margin
 * (10%) keeps an otherwise-valid invocation from failing with `tx_insufficient_fee`.
 */
const RESOURCE_FEE_MARGIN_BASIS_POINTS = 1_100n; // 110% of the simulated minimum
const BASIS_POINTS = 1_000n;

export interface UnsignedReleaseTransaction {
  xdr: string;
  network: string;
  networkPassphrase: string;
  contractId: string;
  sourceAccount: string;
}

/**
 * Builds (but never signs or submits) the Soroban invocation that releases an escrow
 * on-chain — the write-path prototype for the #180 spike.
 *
 * The backend holds no signing keys anywhere in this codebase (there is no KMS/HSM/secrets
 * manager integration), so per the spike's recommendation this stays that way: the caller's
 * own wallet signs the returned XDR and submits it directly to Soroban RPC. The result then
 * flows back into EscrowService the same way any other on-chain change already does — through
 * event-ingestion — so nothing downstream of this needs to change.
 */
@Injectable()
export class EscrowReleaseTransactionBuilderService {
  private readonly logger = new SanitizedLogger(EscrowReleaseTransactionBuilderService.name);

  constructor(
    @Inject(SOROBAN_RPC_SERVER) private readonly rpcServer: SorobanRpc.Server,
    @Inject(ESCROW_WRITE_STELLAR_CONFIG) private readonly config: StellarConfig,
  ) {}

  get isConfigured(): boolean {
    return Boolean(this.config.contractId);
  }

  async buildRelease(
    contractEscrowId: string,
    sourceAccount: string,
  ): Promise<UnsignedReleaseTransaction> {
    if (!this.isConfigured) {
      throw new ServiceUnavailableException(
        'TRUSTFLOW_CONTRACT_ID is not set; cannot build a release transaction with no contract to call.',
      );
    }

    const account = await this.rpcServer.getAccount(sourceAccount);
    const contract = new Contract(this.config.contractId);
    const operation = contract.call(
      RELEASE_ENTRYPOINT,
      nativeToScVal(contractEscrowId, { type: 'string' }),
    );

    const buildWithFee = (fee: string): TransactionBuilder =>
      new TransactionBuilder(account, {
        fee,
        networkPassphrase: this.config.networkPassphrase,
      })
        .addOperation(operation)
        .setTimeout(config.STELLAR_TX_VALIDITY_SECONDS);

    // Simulate explicitly so the resource fee estimated from the contract invocation is
    // actually used. Relying on the flat BASE_FEE (or on prepareTransaction's implicit
    // simulation) left above-baseline invocations under-funded at submission time.
    const simulation = await this.rpcServer.simulateTransaction(buildWithFee(BASE_FEE).build());
    if (SorobanRpc.Api.isSimulationError(simulation)) {
      throw new Error(
        `Release simulation failed for escrow ${contractEscrowId}: ${simulation.error}`,
      );
    }

    const minResourceFee = BigInt(simulation.minResourceFee ?? '0');
    const margin =
      (minResourceFee * RESOURCE_FEE_MARGIN_BASIS_POINTS) / BASIS_POINTS - minResourceFee;
    // `assembleTransaction` sets the final fee to `tx.fee + minResourceFee`. Seed the classic
    // fee with BASE_FEE plus the 10% margin so the final fee becomes
    // BASE_FEE + minResourceFee + margin — never the flat base fee alone.
    const seededFee = (BigInt(BASE_FEE) + margin).toString();

    // Assemble auth/footprint from the simulation we already have (no second RPC call).
    const prepared = SorobanRpc.assembleTransaction(
      buildWithFee(seededFee).build(),
      simulation,
    ).build();

    this.logger.log(
      `Built unsigned release transaction for escrow ${contractEscrowId} with fee ${prepared.fee} ` +
        `(minResourceFee=${minResourceFee.toString()})`,
    );

    return {
      xdr: prepared.toXDR(),
      network: this.config.network,
      networkPassphrase: this.config.networkPassphrase,
      contractId: this.config.contractId,
      sourceAccount,
    };
  }
}
