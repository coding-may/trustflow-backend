import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { AdminGuard } from './admin.guard';
import { validateEnv, resetEnvConfig } from '../config/env.config';

function contextWithAddress(address: string | undefined): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => ({ user: address === undefined ? undefined : { address } }),
    }),
  } as unknown as ExecutionContext;
}

// AdminGuard reads config.ADMIN_ADDRESSES in its constructor, which requires validateEnv()
// to have run first — normally done once in main.ts. Each test below changes
// process.env.ADMIN_ADDRESSES then re-validates so config picks up the new value before
// constructing a fresh guard.
function setAdminAddresses(value: string | undefined): void {
  if (value === undefined) delete process.env.ADMIN_ADDRESSES;
  else process.env.ADMIN_ADDRESSES = value;
  resetEnvConfig();
  validateEnv();
}

describe('AdminGuard', () => {
  const ORIGINAL_ADMIN_ADDRESSES = process.env.ADMIN_ADDRESSES;

  afterEach(() => {
    setAdminAddresses(ORIGINAL_ADMIN_ADDRESSES);
  });

  it('allows a caller whose address is in ADMIN_ADDRESSES', () => {
    setAdminAddresses('GADMIN1,GADMIN2');
    const guard = new AdminGuard();

    expect(guard.canActivate(contextWithAddress('GADMIN2'))).toBe(true);
  });

  it('trims whitespace around each configured address', () => {
    setAdminAddresses(' GADMIN1 , GADMIN2 ');
    const guard = new AdminGuard();

    expect(guard.canActivate(contextWithAddress('GADMIN2'))).toBe(true);
  });

  it('rejects a caller whose address is not in ADMIN_ADDRESSES', () => {
    setAdminAddresses('GADMIN1');
    const guard = new AdminGuard();

    expect(() => guard.canActivate(contextWithAddress('GNOTADMIN'))).toThrow(ForbiddenException);
  });

  it('rejects an unauthenticated caller', () => {
    setAdminAddresses('GADMIN1');
    const guard = new AdminGuard();

    expect(() => guard.canActivate(contextWithAddress(undefined))).toThrow(ForbiddenException);
  });

  it('rejects every caller when ADMIN_ADDRESSES is unset (deny by default)', () => {
    setAdminAddresses(undefined);
    const guard = new AdminGuard();

    expect(() => guard.canActivate(contextWithAddress('GANYONE'))).toThrow(ForbiddenException);
  });
});
