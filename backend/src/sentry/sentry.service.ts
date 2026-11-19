/**
 * Normalizes error messages and extracts a static fingerprint for Soroban/Stellar errors (#935).
 * Strips dynamic transaction hashes and sequence numbers so recurring errors group properly in Sentry.
 */
export function computeSorobanFingerprint(message: string, errorType?: string): string[] | null {
  const isSoroban =
    /soroban|horizon|stellar|transaction\s+[0-9a-fA-F]{64}|tx\s+[0-9a-fA-F]{64}|ledger\s+\d+/i.test(message) ||
    /soroban|stellar/i.test(errorType ?? '');

  if (!isSoroban) return null;

  // Strip 64-char hex hashes (transaction hashes)
  let normalized = message.replace(/[0-9a-fA-F]{64}/g, '<tx-hash>');
  // Strip Stellar account addresses (G... 56 chars)
  normalized = normalized.replace(/G[A-Z2-7]{55}/g, '<account-id>');
  // Strip sequence numbers / ledger numbers
  normalized = normalized.replace(/\b(sequence|ledger|block)\s*[:=]?\s*\d+\b/gi, '$1 <num>');

  return [errorType || 'SorobanError', normalized];
}

import { Injectable } from '@nestjs/common';
import { SanitizedLogger } from '../common/logging/sanitized-logger';
import {
  REDACTED,
  redactIp,
  redactString,
  redactUrl,
  redactValue,
} from '../common/logging/redaction';
import * as Sentry from '@sentry/node';
import { config } from '../config/env.config';

@Injectable()
export class SentryService {
  private readonly logger = new SanitizedLogger(SentryService.name);
  private initialized = false;

  init(): void {
    const dsn = config.SENTRY_DSN;
    const isProduction = config.NODE_ENV === 'production';

    if (!dsn) {
      this.logger.warn('SENTRY_DSN not set — Sentry error reporting disabled.');
      return;
    }

    const tracesSampleRate =
      config.SENTRY_TRACES_SAMPLE_RATE ?? (isProduction ? 0.2 : 1.0);

    Sentry.init({
      dsn,
      environment: config.NODE_ENV,
      release: config.APP_RELEASE,
      tracesSampleRate,
      enabled: !!dsn,
      // The SDK types `beforeSend` against `ErrorEvent`, but `scrubEvent` is declared over the
      // `Event` base because every field it touches lives there. Widening the parameter and
      // narrowing the return keeps the cast one-directional and reviewable.
      beforeSend: (event: Sentry.Event) => scrubEvent(event) as never,
    });

    this.initialized = true;
    this.logger.log(`Sentry initialized (env: ${config.NODE_ENV})`);
  }

  captureException(exception: unknown, context?: string): string {
    if (!this.initialized) return '';
    return Sentry.withScope(scope => {
      if (context) scope.setTag('context', context);
      return Sentry.captureException(exception);
    });
  }

  captureMessage(message: string, level: Sentry.SeverityLevel = 'info'): string {
    if (!this.initialized) return '';
    return Sentry.captureMessage(message, level);
  }

  isInitialized(): boolean {
    return this.initialized;
  }
}

/**
 * Strips sensitive data from an outbound Sentry event.
 *
 * Without this, anything that ended up inside an `Error` message or stack — a pg error
 * carrying row values, a webhook URL containing a token, a request URL carrying a query-string
 * credential — was transmitted verbatim to the third party and retained there under its own
 * retention policy. The exception object is the one payload that the app's own logging layer
 * cannot intercept before it leaves the process, so it has to be scrubbed at the boundary.
 *
 * Applies the same key- and value-based policy as `src/common/logging/redaction.ts`, plus
 * dedicated passes for the `url` tag the exception filter attaches (path + query string), for
 * the HTTP `request` the SDK attaches to server-side errors, and for the breadcrumbs.
 */
export function scrubEvent(event: Sentry.Event): Sentry.Event {
  const scrubbed = { ...event } as Sentry.Event & Record<string, unknown>;

  if (typeof scrubbed.message === 'string') {
    scrubbed.message = redactString(scrubbed.message);
  }

  if (scrubbed.tags) {
    const tags: Record<string, string> = {};
    for (const [key, value] of Object.entries(scrubbed.tags)) {
      const asString = String(value ?? '');
      tags[key] = key === 'url' ? redactUrl(asString) : redactString(asString);
    }
    scrubbed.tags = tags;
  }

  if (scrubbed.extra && typeof scrubbed.extra === 'object') {
    scrubbed.extra = redactValue(scrubbed.extra) as Record<string, unknown>;
  }

  if (scrubbed.contexts && typeof scrubbed.contexts === 'object') {
    scrubbed.contexts = redactValue(scrubbed.contexts) as Sentry.Event['contexts'];
  }

  if (scrubbed.user && typeof scrubbed.user === 'object') {
    // The filter only ever sets the IP; keep the reduction consistent with the logs.
    const user = scrubbed.user;
    if (typeof user.ip_address === 'string') {
      user.ip_address = redactIp(user.ip_address);
    }
  }

  // #651 — the HTTP request the SDK attaches to a server-side error. Its `headers` carry
  // `Authorization: Bearer <jwt>` and session `cookie`s, and its `data`/`body` carry the raw
  // wallet auth payload (address + base64 signature). None of it was being scrubbed, so every
  // 5xx on /auth/verify exported a live credential to the third party.
  if (scrubbed.request && typeof scrubbed.request === 'object') {
    scrubbed.request = scrubRequest(scrubbed.request) as Sentry.Event['request'];
  }

  if (typeof scrubbed.query_string === 'string') {
    scrubbed.query_string = redactString(scrubbed.query_string);
  }

  // #651 — breadcrumbs replay the request history leading up to the error, so an HTTP
  // breadcrumb holds the same headers and bodies the request object does.
  if (Array.isArray(scrubbed.breadcrumbs)) {
    scrubbed.breadcrumbs = (scrubbed.breadcrumbs as unknown as unknown[]).map(
      scrubBreadcrumb,
    ) as Sentry.Event['breadcrumbs'];
  }

  // `exception.values[].value` duplicates the message on some SDK versions; the stack frames
  // themselves carry only module/function names, so they need no scrubbing.
  for (const value of scrubbed.exception?.values ?? []) {
    if (typeof value.value === 'string') value.value = redactString(value.value);
  }

  // #935 — normalize Soroban/Horizon error fingerprinting to avoid splitting by unique tx hash
  if (!scrubbed.fingerprint) {
    const rawMsg =
      scrubbed.message ||
      scrubbed.exception?.values?.[0]?.value ||
      '';
    const errType = scrubbed.exception?.values?.[0]?.type;
    const customFingerprint = computeSorobanFingerprint(rawMsg, errType);
    if (customFingerprint) {
      scrubbed.fingerprint = customFingerprint;
    }
  }

  return scrubbed;
}

/**
 * Scrubs the sub-fields of a Sentry HTTP request.
 *
 * `url` loses its query string (tokens routinely arrive as `?token=`), and the header and body
 * maps go through the shared key-based policy, so `Authorization` and `signature` are replaced
 * wholesale while ordinary fields like `content-type` survive and stay useful for diagnosis.
 *
 * Cookie values are redacted unconditionally rather than by name. A session cookie's name is
 * whatever the framework or the app happened to choose (`session`, `sid`, `connect.sid`,
 * `__Host-auth`), so key-based matching would miss most of them; the name is preserved, only
 * the value is dropped, so a report can still say which cookie was set.
 */
function scrubRequest(request: object): object {
  const scrubbed = { ...(request as Record<string, unknown>) };

  if (typeof scrubbed.url === 'string') {
    scrubbed.url = redactUrl(scrubbed.url);
  }

  if (scrubbed.query_string) {
    scrubbed.query_string = redactString(String(scrubbed.query_string));
  }

  if (scrubbed.cookies && typeof scrubbed.cookies === 'object') {
    scrubbed.cookies = redactCookieValues(scrubbed.cookies);
  }

  for (const key of ['headers', 'data', 'body']) {
    if (scrubbed[key] && typeof scrubbed[key] === 'object') {
      scrubbed[key] = redactValue(scrubbed[key]);
    } else if (typeof scrubbed[key] === 'string') {
      // `data`/`body` arrive as a string when the SDK could not parse the body as JSON.
      scrubbed[key] = redactString(scrubbed[key]);
    }
  }

  return scrubbed;
}

/** Replaces every value in a cookie map, keeping the cookie names for diagnostics. */
function redactCookieValues(cookies: object): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(cookies as Record<string, unknown>)) {
    // The raw Cookie header form ("a=1; b=2") is a string, not a map.
    output[name] = typeof value === 'string' ? REDACTED : redactValue(value);
  }
  return output;
}

/** Scrubs a single breadcrumb's message, URL and data payload. */
function scrubBreadcrumb(breadcrumb: unknown): unknown {
  if (!breadcrumb || typeof breadcrumb !== 'object') return breadcrumb;
  const scrubbed = { ...(breadcrumb as Record<string, unknown>) };

  if (typeof scrubbed.message === 'string') {
    scrubbed.message = redactString(scrubbed.message);
  }
  if (typeof scrubbed.url === 'string') {
    scrubbed.url = redactUrl(scrubbed.url);
  }
  if (scrubbed.data && typeof scrubbed.data === 'object') {
    const data = redactValue(scrubbed.data) as Record<string, unknown>;
    // An HTTP breadcrumb carries its target URL at `data.url`, so the query-string pass in
    // `redactValue` (which only special-cases a real `URL` instance) has to be applied here.
    if (typeof data.url === 'string') {
      data.url = redactUrl(data.url);
    }
    scrubbed.data = data;
  }

  return scrubbed;
}
