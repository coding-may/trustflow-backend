# JWT Authentication for Wallet Signatures - Implementation Documentation

## Overview

This implementation provides JWT-based authentication for the TrustFlow protocol using Stellar wallet signatures. Users authenticate by signing a nonce with their Freighter wallet, proving ownership of their Stellar address without exposing private keys.

## Architecture

### Components

1. **AuthModule** (`auth.module.ts`)
   - Configures JWT and Passport modules
   - Registers AuthService, AuthController, and JwtStrategy
   - Exports AuthService for use in other modules

2. **AuthService** (`auth.service.ts`)
   - Generates cryptographic challenges for wallet signing
   - Verifies Stellar signatures using @stellar/stellar-sdk
   - Issues JWT tokens upon successful authentication
   - Validates JWT tokens for protected routes

3. **AuthController** (`auth.controller.ts`)
   - `GET /auth/challenge` - Generates a challenge message for wallet signing
   - `POST /auth/verify` - Verifies wallet signature and returns JWT token

4. **JwtStrategy** (`jwt.strategy.ts`)
   - Passport strategy for JWT validation
   - Extracts JWT from Authorization header
   - Validates token signature and expiration

5. **JwtAuthGuard** (`auth.guard.ts`)
   - Guards protected routes using JWT authentication
   - Extends NestJS AuthGuard with custom error handling

6. **DTOs** (`dto/`)
   - `ChallengeDto` - Validates wallet address format
   - `VerifyDto` - Validates signature verification request
   - `ChallengeResponseDto` - Challenge response schema
   - `TokenResponseDto` - JWT token response schema

## Authentication Flow

### Step 1: Request Challenge
```bash
GET /auth/challenge?address=GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX
```

**Response:**
```json
{
  "challenge": "Sign this message to authenticate with TrustFlow: a1b2c3d4..."
}
```

### Step 2: Sign Challenge with Freighter Wallet
The user signs the challenge message using their Freighter wallet. The signature is returned as a base64-encoded string.

### Step 3: Verify Signature and Get JWT
```bash
POST /auth/verify
Content-Type: application/json

{
  "address": "GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
  "signature": "SGVsbG8gV29ybGQh..."
}
```

**Response:**
```json
{
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
}
```

### Step 4: Use JWT for Protected Routes
```bash
GET /escrows
Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
```

## Security Features

1. **Challenge Expiration**: Challenges expire after 60 seconds to prevent replay attacks
2. **One-Time Use**: Each challenge can only be used once — `NonceStoreService.consume()` atomically
   reads and deletes the pending challenge (`GETDEL`), so a second `/auth/verify` call for the same
   address always fails with "Challenge not found, expired, or already consumed", regardless of
   whether the first call's signature was valid. **A failed signature still burns the challenge**:
   since `consume()` runs before signature verification, an attacker cannot brute-force signatures
   against a single outstanding challenge — each attempt requires a fresh `GET /auth/challenge`.
   `markNonceUsed()` additionally marks the nonce itself used (atomic `SET NX`) immediately after a
   *valid* signature, as defense in depth against the nonce being reused across a distinct challenge.
3. **Stellar Signature Verification**: Uses @stellar/stellar-sdk for cryptographic verification
4. **JWT Expiration**: Tokens expire after 24 hours
5. **Address Validation**: Validates Stellar public key format (G-prefixed, 56 characters)
6. **Input Validation**: Uses class-validator for request validation

## Dependencies

### New Dependencies Added
- `@stellar/stellar-sdk@^16.0.1` - Stellar SDK for signature verification
- `class-validator@^0.14.4` - Input validation decorators
- `class-transformer@^0.5.1` - Object transformation

### Existing Dependencies Used
- `@nestjs/jwt@^10.0.0` - JWT token generation and validation
- `@nestjs/passport@^10.0.0` - Passport integration
- `passport-jwt@^4.0.1` - JWT strategy for Passport

## Environment Variables

Required environment variables:
```env
JWT_SECRET=your-secret-key-here  # Secret for JWT signing
```

## Configuration

### JWT Configuration
- **Secret**: From `JWT_SECRET` environment variable (defaults to 'dev-secret-change-in-production')
- **Expiration**: 24 hours
- **Algorithm**: HS256

### Challenge Configuration
- **Expiration**: 60 seconds
- **Nonce Length**: 32 bytes (64 hex characters)

## Error Handling

### Common Errors

1. **Challenge Not Found**
   - Status: 401
   - Message: "Challenge not found or expired"
   - Cause: Challenge was never requested or has expired

2. **Invalid Signature**
   - Status: 401
   - Message: "Invalid signature"
   - Cause: Signature verification failed

3. **Invalid Address Format**
   - Status: 400
   - Message: "Invalid Stellar public key format"
   - Cause: Address doesn't match Stellar public key pattern

4. **Missing Token**
   - Status: 401
   - Message: "Missing token"
   - Cause: Authorization header not provided

5. **Invalid Token**
   - Status: 401
   - Message: "Invalid or expired token"
   - Cause: Token is malformed, expired, or signature is invalid

## Testing

### Manual Testing

1. Start the development server:
```bash
npm run dev
```

2. Request a challenge:
```bash
curl "http://localhost:3001/auth/challenge?address=GABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ"
```

3. Sign the challenge using Freighter wallet (client-side)

4. Verify signature and get token:
```bash
curl -X POST http://localhost:3001/auth/verify \
  -H "Content-Type: application/json" \
  -d '{"address":"G...","signature":"..."}'
```

5. Use token for protected routes:
```bash
curl http://localhost:3001/escrows \
  -H "Authorization: Bearer <token>"
```

## Integration with Freighter Wallet

### Client-Side Implementation Example

```typescript
import * as freighter from '@stellar/freighter-api';

// 1. Get user's public key
const address = await freighter.getPublicKey();

// 2. Request challenge from backend
const response = await fetch(`/auth/challenge?address=${address}`);
const { challenge } = await response.json();

// 3. Sign challenge with Freighter
const signature = await freighter.signMessage(challenge, address);

// 4. Verify signature and get JWT
const verifyResponse = await fetch('/auth/verify', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ address, signature }),
});
const { token } = await verifyResponse.json();

// 5. Store token and use for authenticated requests
localStorage.setItem('jwt', token);
```

## Future Enhancements

1. **Rate Limiting**: Add per-wallet rate limiting on auth endpoints
2. **Token Refresh**: Implement refresh token mechanism
3. **Multi-Factor Authentication**: Add optional 2FA support
4. **Session Management**: Add token revocation and session tracking
5. **Auditing**: Log all authentication attempts for security monitoring

## Migration Notes

### Breaking Changes
- None - this is a new feature

### API Changes
- Added `/auth/challenge` endpoint
- Added `/auth/verify` endpoint
- Updated JWT token format (now uses standard JWT instead of custom format)

### Database Changes
- None - challenges are stored in Redis (`NonceStoreService`, backed by `REDIS_CLIENT`) rather than a SQL database

## Production Considerations

1. **Challenge Storage**: Already backed by Redis (`NonceStoreService`) for distributed, multi-node deployments
2. **JWT Secret**: Use a strong, randomly generated secret
3. **HTTPS**: Always use HTTPS in production
4. **Rate Limiting**: Implement rate limiting to prevent abuse
5. **Monitoring**: Monitor authentication failures for security incidents
6. **Key Rotation**: Implement JWT secret rotation strategy

## Support

For issues or questions about this implementation, please refer to:
- TrustFlow API Documentation: http://localhost:3001/api/docs
- Stellar SDK Documentation: https://stellar.github.io/js-stellar-sdk/
- Freighter API Documentation: https://github.com/Credera-Freighter/freighter-api
