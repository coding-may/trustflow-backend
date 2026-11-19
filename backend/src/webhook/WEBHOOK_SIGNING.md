# Webhook Payload Signing

TrustFlow signs every outgoing webhook POST with an HMAC-SHA256 signature included in the
`X-TrustFlow-Signature` request header. Receivers **must** verify this signature before
processing the payload to ensure authenticity and prevent replay attacks.

---

## Header format

```
X-TrustFlow-Signature: t=<unix_ms>,v1=<hex_hmac>
```

| Part | Description |
|------|-------------|
| `t`  | Unix epoch timestamp in **milliseconds** at the time of dispatch |
| `v1` | Lowercase hex-encoded HMAC-SHA256 of the signed content (see below) |

---

## Signed content

The HMAC is computed over:

```
<timestamp>.<raw_json_body>
```

where `<timestamp>` is the same integer value carried in the `t=` field and
`<raw_json_body>` is the **raw, unmodified** UTF-8 request body string.

Binding the timestamp into the signed content means a stolen payload cannot be
replayed later — a receiver that rejects events older than 5 minutes will refuse
re-sent payloads even when the attacker has the raw bytes.

---

## Payload schema version

Every webhook body carries a `schemaVersion` integer:

```json
{
  "event": "dispute.raised",
  "data": { "...": "..." },
  "timestamp": "2026-11-19T00:00:00.000Z",
  "schemaVersion": 1
}
```

Existing subscribers can rely on `schemaVersion: 1` meaning "the shape documented today."
If a future change to an event's payload would break existing consumers, the version for
that event is bumped and announced — check `schemaVersion` before assuming a field's
presence, type, or meaning, rather than keying off the payload shape alone.

---

## Signing secret

A unique 64-character hex secret (32 random bytes) is generated for every endpoint
at registration time and returned **once** in the registration response:

```json
POST /webhooks
{
  "id": "my-hook",
  "url": "https://example.com/trustflow/events"
}

→ 201
{
  "registered": true,
  "id": "my-hook",
  "signingSecret": "a3f9c2d1e4b5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1"
}
```

Store this secret securely (e.g. in an environment variable or secret manager).
It is **never returned again** after registration.

You may supply your own secret instead:

```json
{
  "id": "my-hook",
  "url": "https://example.com/trustflow/events",
  "secret": "my-at-least-16-character-secret"
}
```

---

## Verification example (Node.js)

```typescript
import * as crypto from 'crypto';

/**
 * Verify an inbound TrustFlow webhook request.
 *
 * @param rawBody      - Raw UTF-8 request body string (do NOT parse before verifying)
 * @param sigHeader    - Value of the X-TrustFlow-Signature header
 * @param secret       - Your endpoint signing secret
 * @param toleranceMs  - Max age of the event in ms before it is rejected (default 5 min)
 */
function verifyTrustFlowWebhook(
  rawBody: string,
  sigHeader: string,
  secret: string,
  toleranceMs = 5 * 60 * 1000,
): void {
  // 1. Parse header parts
  const parts = Object.fromEntries(
    sigHeader.split(',').map(part => part.split('=')),
  );
  const timestamp = parts['t'];
  const receivedHmac = parts['v1'];

  if (!timestamp || !receivedHmac) {
    throw new Error('Missing t= or v1= in X-TrustFlow-Signature header');
  }

  // 2. Reject stale events (replay attack prevention)
  const age = Date.now() - Number(timestamp);
  if (age > toleranceMs) {
    throw new Error(`Webhook timestamp is too old (${age}ms > ${toleranceMs}ms tolerance)`);
  }

  // 3. Recompute expected HMAC
  const signedContent = `${timestamp}.${rawBody}`;
  const expected = crypto
    .createHmac('sha256', secret)
    .update(signedContent, 'utf8')
    .digest('hex');

  // 4. Constant-time comparison to prevent timing attacks
  const expectedBuf = Buffer.from(expected, 'utf8');
  const receivedBuf = Buffer.from(receivedHmac, 'utf8');

  if (
    expectedBuf.length !== receivedBuf.length ||
    !crypto.timingSafeEqual(expectedBuf, receivedBuf)
  ) {
    throw new Error('Webhook signature mismatch — payload may have been tampered with');
  }
}
```

### Express middleware example

```typescript
import express from 'express';

const app = express();

// IMPORTANT: use raw body parser so the body string is not altered before verification
app.post(
  '/trustflow/events',
  express.raw({ type: 'application/json' }),
  (req, res) => {
    const rawBody = req.body.toString('utf8');
    const sigHeader = req.headers['x-trustflow-signature'] as string;

    try {
      verifyTrustFlowWebhook(rawBody, sigHeader, process.env.TRUSTFLOW_WEBHOOK_SECRET!);
    } catch (err) {
      console.error('Webhook verification failed:', err.message);
      return res.status(401).send('Unauthorized');
    }

    const event = JSON.parse(rawBody);
    console.log('Verified event:', event.event, event.data);
    res.status(200).send('OK');
  },
);
```

---

## Security notes

- Always verify the signature **before** parsing or acting on the payload.
- Use raw (unparsed) body bytes for verification — JSON re-serialization can change byte order.
- Implement the replay-attack window (5 minutes recommended). Your system clock must be
  reasonably in sync with NTP.
- Use `crypto.timingSafeEqual` for comparison — regular string equality leaks timing information.
- Rotate your secret by re-registering the endpoint with a new secret value. There is no
  partial overlap window; update your receiver before re-registering.
