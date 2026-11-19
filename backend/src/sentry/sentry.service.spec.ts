import { Test, TestingModule } from '@nestjs/testing';
import { SentryService, scrubEvent, computeSorobanFingerprint } from './sentry.service';

// Mock @sentry/node so tests never make network calls
jest.mock('@sentry/node', () => ({
  init: jest.fn(),
  captureException: jest.fn().mockReturnValue('mock-event-id'),
  captureMessage: jest.fn().mockReturnValue('mock-msg-id'),
  withScope: jest.fn((cb: (scope: unknown) => unknown) => {
    const scope = { setTag: jest.fn(), setExtra: jest.fn(), setUser: jest.fn() };
    return cb(scope);
  }),
}));

import * as Sentry from '@sentry/node';

describe('SentryService', () => {
  let service: SentryService;
  const originalEnv = { ...process.env };

  beforeEach(async () => {
    jest.clearAllMocks();
    process.env = { ...originalEnv };

    const module: TestingModule = await Test.createTestingModule({
      providers: [SentryService],
    }).compile();

    service = module.get<SentryService>(SentryService);
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('init()', () => {
    it('should not call Sentry.init when SENTRY_DSN is missing', () => {
      delete process.env.SENTRY_DSN;
      service.init();
      expect(Sentry.init).not.toHaveBeenCalled();
      expect(service.isInitialized()).toBe(false);
    });

    it('should call Sentry.init with correct options when DSN is set', () => {
      process.env.SENTRY_DSN = 'https://test@sentry.io/1';
      process.env.NODE_ENV = 'production';
      service.init();
      expect(Sentry.init).toHaveBeenCalledWith(
        expect.objectContaining({
          dsn: 'https://test@sentry.io/1',
          environment: 'production',
          enabled: true,
        }),
      );
      expect(service.isInitialized()).toBe(true);
    });

    it('should use lower tracesSampleRate in production', () => {
      process.env.SENTRY_DSN = 'https://test@sentry.io/1';
      process.env.NODE_ENV = 'production';
      service.init();
      expect(Sentry.init).toHaveBeenCalledWith(expect.objectContaining({ tracesSampleRate: 0.2 }));
    });

    it('should use full tracesSampleRate in non-production', () => {
      process.env.SENTRY_DSN = 'https://test@sentry.io/1';
      process.env.NODE_ENV = 'development';
      service.init();
      expect(Sentry.init).toHaveBeenCalledWith(expect.objectContaining({ tracesSampleRate: 1.0 }));
    });

    it('should use configured SENTRY_TRACES_SAMPLE_RATE when provided (#934)', () => {
      process.env.SENTRY_DSN = 'https://test@sentry.io/1';
      process.env.NODE_ENV = 'production';
      process.env.SENTRY_TRACES_SAMPLE_RATE = '0.05';
      service.init();
      expect(Sentry.init).toHaveBeenCalledWith(expect.objectContaining({ tracesSampleRate: 0.05 }));
    });
  });

  describe('captureException()', () => {
    it('should return empty string when Sentry is not initialized', () => {
      const result = service.captureException(new Error('test'));
      expect(result).toBe('');
      expect(Sentry.captureException).not.toHaveBeenCalled();
    });

    it('should call Sentry.captureException and return event id when initialized', () => {
      process.env.SENTRY_DSN = 'https://test@sentry.io/1';
      service.init();
      const result = service.captureException(new Error('boom'), 'TestContext');
      expect(Sentry.captureException).toHaveBeenCalled();
      expect(result).toBe('mock-event-id');
    });
  });

  describe('captureMessage()', () => {
    it('should return empty string when Sentry is not initialized', () => {
      const result = service.captureMessage('hello');
      expect(result).toBe('');
      expect(Sentry.captureMessage).not.toHaveBeenCalled();
    });

    it('should call Sentry.captureMessage with level when initialized', () => {
      process.env.SENTRY_DSN = 'https://test@sentry.io/1';
      service.init();
      const result = service.captureMessage('deploy notice', 'warning');
      expect(Sentry.captureMessage).toHaveBeenCalledWith('deploy notice', 'warning');
      expect(result).toBe('mock-msg-id');
    });
  });

  describe('isInitialized()', () => {
    it('should return false before init is called', () => {
      expect(service.isInitialized()).toBe(false);
    });

    it('should return false when DSN is absent even after init', () => {
      delete process.env.SENTRY_DSN;
      service.init();
      expect(service.isInitialized()).toBe(false);
    });
  });
});

/**
 * #651 — `beforeSend` must strip credentials from the HTTP request the Sentry SDK attaches to
 * server-side errors, and from the breadcrumbs that replay the request history.
 *
 * These call `scrubEvent` directly rather than going through `Sentry.init`, because the SDK is
 * mocked in this file and the hook is what actually holds the guarantee.
 */
describe('scrubEvent (#651)', () => {
  const BEARER =
    'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJHNtYWRlIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk';
  const SIGNATURE = 'SGVsbG8gV29ybGQhIFNpZ25lZCBUaGlzIHdhbGxldCBjaGFsbGVuZ2U=';

  /**
   * The SDK's `RequestEventData` type declares `data` but not the `body` alias some
   * integrations emit, so build the request loosely and read it back the same way.
   */
  function eventWithRequest(request: Record<string, unknown>): Sentry.Event {
    return { request } as unknown as Sentry.Event;
  }

  function requestOf(event: Sentry.Event): Record<string, unknown> {
    return event.request as unknown as Record<string, unknown>;
  }

  it('redacts the Authorization header while keeping the request diagnosable', () => {
    const scrubbed = scrubEvent(
      eventWithRequest({
        url: 'https://api.trustflow.io/escrows/abc',
        method: 'POST',
        headers: { Authorization: `Bearer ${BEARER}`, 'content-type': 'application/json' },
      }),
    );

    const request = requestOf(scrubbed);
    const headers = request.headers as Record<string, string>;
    expect(headers.Authorization).toBe('[REDACTED]');
    expect(headers.Authorization).not.toContain(BEARER);
    // A redacted header is useless for debugging if the request is flattened out too.
    expect(headers['content-type']).toBe('application/json');
    expect(request.method).toBe('POST');
  });

  it('redacts cookie values regardless of the cookie name', () => {
    // Cookie names are framework-chosen (`session`, `sid`, `__Host-auth`), so key-based
    // matching would miss most session cookies. Names survive; values never do.
    const scrubbed = scrubEvent(
      eventWithRequest({ cookies: { session: 'abc123', __Host_auth: 'def456' } }),
    );

    const cookies = requestOf(scrubbed).cookies as Record<string, string>;
    expect(cookies.session).toBe('[REDACTED]');
    expect(cookies.__Host_auth).toBe('[REDACTED]');
    expect(JSON.stringify(scrubbed)).not.toContain('abc123');
    expect(JSON.stringify(scrubbed)).not.toContain('def456');
  });

  it('redacts the wallet signature payload from the request body', () => {
    const scrubbed = scrubEvent(
      eventWithRequest({
        url: 'https://api.trustflow.io/auth/verify',
        data: { address: 'GABC', signature: SIGNATURE },
      }),
    );

    const data = requestOf(scrubbed).data as Record<string, string>;
    expect(data.signature).toBe('[REDACTED]');
    expect(JSON.stringify(scrubbed)).not.toContain(SIGNATURE);
    // The address is not a secret and is what makes the event actionable.
    expect(data.address).toBe('GABC');
  });

  it('redacts a `body` alias when the SDK used that key instead of `data`', () => {
    const scrubbed = scrubEvent(
      eventWithRequest({ body: { address: 'GABC', signature: SIGNATURE } }),
    );

    const body = requestOf(scrubbed).body as Record<string, string>;
    expect(body.signature).toBe('[REDACTED]');
    expect(JSON.stringify(scrubbed)).not.toContain(SIGNATURE);
  });

  it('redacts a string body that the SDK could not parse as JSON', () => {
    const scrubbed = scrubEvent(eventWithRequest({ data: `address=GABC&signature=${SIGNATURE}` }));

    expect(String(requestOf(scrubbed).data)).not.toContain(SIGNATURE);
  });

  it('drops the query string from the request URL', () => {
    const scrubbed = scrubEvent(
      eventWithRequest({ url: `https://api.trustflow.io/escrows?token=${BEARER}&page=2` }),
    );

    expect(String(requestOf(scrubbed).url)).not.toContain(BEARER);
    expect(String(requestOf(scrubbed).url)).toContain('/escrows');
  });

  it('redacts the wallet auth nonce from the request body', () => {
    const scrubbed = scrubEvent(
      eventWithRequest({ data: { address: 'GABC', nonce: 'n-0S6_WzA2Mj' } }),
    );

    const data = requestOf(scrubbed).data as Record<string, string>;
    expect(data.nonce).toBe('[REDACTED]');
    expect(JSON.stringify(scrubbed)).not.toContain('n-0S6_WzA2Mj');
  });

  it('redacts credentials carried in breadcrumbs', () => {
    const scrubbed = scrubEvent({
      breadcrumbs: [
        {
          category: 'http',
          message: 'POST /auth/verify 500',
          data: { headers: { Authorization: `Bearer ${BEARER}` }, signature: SIGNATURE },
        },
        {
          category: 'http',
          message: 'GET /ok',
          // An HTTP breadcrumb keeps its target URL at `data.url`.
          data: { url: `https://api.trustflow.io/x?token=${BEARER}` },
        },
      ],
    });

    const serialized = JSON.stringify(scrubbed);
    expect(serialized).not.toContain(BEARER);
    expect(serialized).not.toContain(SIGNATURE);
    // Diagnostics survive redaction.
    expect(scrubbed.breadcrumbs?.[0].message).toBe('POST /auth/verify 500');
    expect(scrubbed.breadcrumbs?.[1].message).toBe('GET /ok');
  });

  it('leaves a request with nothing sensitive untouched apart from redaction', () => {
    const scrubbed = scrubEvent(
      eventWithRequest({ url: 'https://api.trustflow.io/escrows', method: 'GET' }),
    );

    expect(requestOf(scrubbed)).toEqual({
      url: 'https://api.trustflow.io/escrows',
      method: 'GET',
    });
  });

  it('tolerates a request that is absent or malformed', () => {
    expect(() => scrubEvent({})).not.toThrow();
    expect(scrubEvent({ request: undefined }).request).toBeUndefined();
  });

  describe('Soroban error fingerprinting (#935)', () => {
    it('sets normalized fingerprint for Soroban error with tx hash', () => {
      const txHash1 = 'a1b2c3d4e5f60123456789abcdef0123456789abcdef0123456789abcdef0123';
      const txHash2 = 'fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210';

      const event1 = scrubEvent({
        message: `Soroban transaction ${txHash1} failed at ledger 123456`,
      });
      const event2 = scrubEvent({
        message: `Soroban transaction ${txHash2} failed at ledger 789012`,
      });

      expect(event1.fingerprint).toBeDefined();
      expect(event2.fingerprint).toBeDefined();
      expect(event1.fingerprint).toEqual(event2.fingerprint);
      expect(event1.fingerprint?.[1]).toContain('<tx-hash>');
      expect(event1.fingerprint?.[1]).toContain('<num>');
    });

    it('does not set custom fingerprint on ordinary non-Soroban errors', () => {
      const event = scrubEvent({
        message: 'Normal database connection error',
      });
      expect(event.fingerprint).toBeUndefined();
    });
  });
});
