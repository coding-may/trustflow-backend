import {
  Account,
  BASE_FEE,
  Keypair,
  SorobanDataBuilder,
  Transaction,
  rpc as SorobanRpc,
  xdr,
} from '@stellar/stellar-sdk';
import { EscrowReleaseTransactionBuilderService } from './escrow-release-transaction-builder.service';
import { validateEnv } from '../config/env.config';
import { getStellarConfig } from '../stellar/stellar.config';

// getStellarConfig() reads validated env config — normally done once in main.ts.
validateEnv();

const TEST_CONTRACT_ID = 'CBNXX7I4MGHZO3YAKXJIJNR5TTNSP6R2JAXMA44FS47JSTYAW7LIR4CS';

function makeRpcServer() {
  return {
    getAccount: jest.fn(),
    simulateTransaction: jest.fn(),
    prepareTransaction: jest.fn(),
  };
}

/** A minimal *parsed* simulation response suitable for `assembleTransaction`. */
function makeSimulation(minResourceFee: string): SorobanRpc.Api.SimulateTransactionResponse {
  return {
    _parsed: true,
    latestLedger: 1,
    minResourceFee,
    transactionData: new SorobanDataBuilder(),
    cost: { cpuInsns: '0', memBytes: '0' },
    events: [],
    result: { auth: [], retval: xdr.ScVal.scvVoid() },
  } as unknown as SorobanRpc.Api.SimulateTransactionResponse;
}

describe('EscrowReleaseTransactionBuilderService', () => {
  describe('not configured (no contractId)', () => {
    let rpcServer: ReturnType<typeof makeRpcServer>;
    let service: EscrowReleaseTransactionBuilderService;

    beforeEach(() => {
      rpcServer = makeRpcServer();
      service = new EscrowReleaseTransactionBuilderService(
        rpcServer as unknown as SorobanRpc.Server,
        { ...getStellarConfig(), contractId: '' },
      );
    });

    it('reports not configured', () => {
      expect(service.isConfigured).toBe(false);
    });

    it('refuses to build a transaction against no contract, without touching the RPC server', async () => {
      await expect(service.buildRelease('esc-1', Keypair.random().publicKey())).rejects.toThrow(
        'TRUSTFLOW_CONTRACT_ID is not set',
      );
      expect(rpcServer.getAccount).not.toHaveBeenCalled();
    });
  });

  describe('configured (contractId set)', () => {
    let rpcServer: ReturnType<typeof makeRpcServer>;
    let service: EscrowReleaseTransactionBuilderService;

    beforeEach(() => {
      rpcServer = makeRpcServer();
      service = new EscrowReleaseTransactionBuilderService(
        rpcServer as unknown as SorobanRpc.Server,
        { ...getStellarConfig(), contractId: TEST_CONTRACT_ID },
      );
    });

    it('reports configured', () => {
      expect(service.isConfigured).toBe(true);
    });

    it('builds an unsigned release transaction via the invoking account and returns its XDR', async () => {
      const sourceKeypair = Keypair.random();
      const sourceAccount = new Account(sourceKeypair.publicKey(), '100');
      rpcServer.getAccount.mockResolvedValue(sourceAccount);
      rpcServer.simulateTransaction.mockResolvedValue(makeSimulation('1000'));

      const result = await service.buildRelease('esc-1', sourceKeypair.publicKey());

      expect(rpcServer.getAccount).toHaveBeenCalledWith(sourceKeypair.publicKey());
      expect(rpcServer.simulateTransaction).toHaveBeenCalledTimes(1);

      const built = new Transaction(result.xdr, getStellarConfig().networkPassphrase);
      expect(built.operations).toHaveLength(1);
      expect(built.operations[0].type).toBe('invokeHostFunction');

      const { xdr, ...rest } = result;
      expect(typeof xdr).toBe('string');
      expect(rest).toEqual({
        network: getStellarConfig().network,
        networkPassphrase: getStellarConfig().networkPassphrase,
        contractId: TEST_CONTRACT_ID,
        sourceAccount: sourceKeypair.publicKey(),
      });
    });

    it('uses the simulated minResourceFee plus a 10% margin instead of a flat base fee', async () => {
      const sourceKeypair = Keypair.random();
      rpcServer.getAccount.mockResolvedValue(new Account(sourceKeypair.publicKey(), '100'));
      rpcServer.simulateTransaction.mockResolvedValue(makeSimulation('1000'));

      const result = await service.buildRelease('esc-1', sourceKeypair.publicKey());
      const built = new Transaction(result.xdr, getStellarConfig().networkPassphrase);

      // 1000 stroops resource fee + 10% margin + 100 stroop classic base fee = 1200.
      expect(built.fee).toBe((BigInt(BASE_FEE) + 1100n).toString());
    });

    it('floors the fee at the classic base fee when simulation reports no resource fee', async () => {
      const sourceKeypair = Keypair.random();
      rpcServer.getAccount.mockResolvedValue(new Account(sourceKeypair.publicKey(), '100'));
      rpcServer.simulateTransaction.mockResolvedValue(makeSimulation('0'));

      const result = await service.buildRelease('esc-1', sourceKeypair.publicKey());
      const built = new Transaction(result.xdr, getStellarConfig().networkPassphrase);

      expect(built.fee).toBe(BASE_FEE);
    });

    it('propagates simulation errors instead of building an underfunded transaction', async () => {
      const sourceKeypair = Keypair.random();
      rpcServer.getAccount.mockResolvedValue(new Account(sourceKeypair.publicKey(), '100'));
      rpcServer.simulateTransaction.mockResolvedValue({
        _parsed: true,
        error: 'HostError: invalid invocation',
        events: [],
      });

      await expect(service.buildRelease('esc-1', sourceKeypair.publicKey())).rejects.toThrow(
        'Release simulation failed for escrow esc-1: HostError: invalid invocation',
      );
    });

    it('propagates RPC errors instead of swallowing them', async () => {
      rpcServer.getAccount.mockRejectedValue(new Error('account not found'));

      await expect(service.buildRelease('esc-1', Keypair.random().publicKey())).rejects.toThrow(
        'account not found',
      );
    });
  });
});
