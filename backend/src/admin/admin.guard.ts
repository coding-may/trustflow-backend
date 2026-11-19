import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { SanitizedLogger } from '../common/logging/sanitized-logger';
import { config } from '../config/env.config';
import { parseAdminAddresses } from './admin-addresses.util';

/**
 * Restricts access to addresses listed in `ADMIN_ADDRESSES` (comma-separated Stellar public
 * keys). Runs after `JwtAuthGuard`, which is what populates `request.user.address` — there is
 * no separate admin login flow, an admin authenticates with the same wallet-signature flow as
 * everyone else and is simply allow-listed by address.
 *
 * Deny-by-default: an unset or empty `ADMIN_ADDRESSES` locks every admin route out rather than
 * leaving them open, since there is no safe default allow-list for a protocol-admin surface.
 */
@Injectable()
export class AdminGuard implements CanActivate {
  private readonly logger = new SanitizedLogger(AdminGuard.name);
  private readonly adminAddresses: Set<string>;

  constructor() {
    this.adminAddresses = parseAdminAddresses(config.ADMIN_ADDRESSES);

    if (this.adminAddresses.size === 0) {
      this.logger.warn(
        'ADMIN_ADDRESSES is not configured — every admin route will return 403 until it is set',
      );
    }
  }

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest();
    const address: string | undefined = request.user?.address;

    if (!address || !this.adminAddresses.has(address)) {
      this.logger.warn(`Admin access denied for ${address ?? 'unauthenticated caller'}`);
      throw new ForbiddenException('Admin access required');
    }

    return true;
  }
}
