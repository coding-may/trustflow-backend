import { Injectable, UnauthorizedException, Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as crypto from 'crypto';
import * as StellarSdk from '@stellar/stellar-sdk';
import { NonceStoreService } from './nonce-store.service';

const CHALLENGE_PREFIX = 'Sign this message to authenticate with TrustFlow: ';

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private jwtService: JwtService,
    private nonceStore: NonceStoreService,
  ) {}

  async generateChallenge(address: string): Promise<string> {
    const nonce = crypto.randomBytes(32).toString('hex');
    const challenge = `${CHALLENGE_PREFIX}${nonce}`;

    await this.nonceStore.store(address, challenge, nonce);
    this.logger.debug(`Challenge generated for ${this.maskAddress(address)}`);

    return challenge;
  }

  async verifySignature(address: string, signature: string): Promise<boolean> {
    const challenge = await this.nonceStore.consume(address);
    if (!challenge) {
      throw new UnauthorizedException('Challenge not found, expired, or already consumed');
    }

    const nonce = this.extractNonce(challenge);

    try {
      const signatureBuffer = Buffer.from(signature, 'base64');
      const challengeBuffer = Buffer.from(challenge, 'utf-8');

      const keypair = StellarSdk.Keypair.fromPublicKey(address);
      const isValid = keypair.verify(challengeBuffer, signatureBuffer);

      if (isValid && nonce) {
        const firstUse = await this.nonceStore.markNonceUsed(nonce);
        if (!firstUse) {
          this.logger.warn(`Replay attempt detected for ${this.maskAddress(address)}`);
          throw new UnauthorizedException('Challenge already used — replay blocked');
        }
        this.logger.debug(`Signature verified for ${this.maskAddress(address)}`);
      }

      return isValid;
    } catch (error) {
      if (error instanceof UnauthorizedException) throw error;
      this.logger.warn(
        `Signature verification failed for ${this.maskAddress(address)}: ${error instanceof Error ? error.message : 'unknown'}`,
      );
      throw new UnauthorizedException('Invalid signature');
    }
  }

  generateToken(address: string): string {
    const payload = { address, sub: address };
    return this.jwtService.sign(payload);
  }

  validateToken(token: string): unknown {
    try {
      return this.jwtService.verify(token);
    } catch (error) {
      throw new UnauthorizedException('Invalid token');
    }
  }

  private extractNonce(challenge: string): string | null {
    if (!challenge.startsWith(CHALLENGE_PREFIX)) return null;
    return challenge.slice(CHALLENGE_PREFIX.length);
  }

  private maskAddress(address: string): string {
    if (address.length <= 12) return '****';
    return `${address.slice(0, 6)}...${address.slice(-4)}`;
  }
}
