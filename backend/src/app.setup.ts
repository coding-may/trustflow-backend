import { INestApplication, ValidationPipe, VersioningType } from '@nestjs/common';
import { SanitizedLogger } from './common/logging/sanitized-logger';
import { SwaggerModule, DocumentBuilder, OpenAPIObject } from '@nestjs/swagger';
import * as express from 'express';
import type { RequestHandler } from 'express';
import { createSecurityHeadersMiddleware } from './common/http/docs-security';
import { SentryService } from './sentry/sentry.service';
import { SentryExceptionFilter } from './common/filters/sentry-exception.filter';
import { SorobanEventIndexerService } from './soroban-event-indexer/soroban-event-indexer.service';
import { MetricsHttpInterceptor } from './monitoring/metrics-http.interceptor';
import { RequestTimeoutInterceptor } from './common/http/request-timeout.interceptor';
import { CorrelationIdStore } from './common/logging/correlation-id.store';
import { config } from './config/env.config';

const logger = new SanitizedLogger('AppSetup');

export interface ConfigureAppOptions {
  /**
   * Skip initializing the Sentry SDK (which reaches out over the network when a DSN is
   * configured). The exception filter, interceptors, pipes, CORS and body limits are all
   * still applied. Use in tests that don't want Sentry's side effects. Default: false.
   */
  skipSentryInit?: boolean;
  /**
   * Skip starting the Soroban event indexer (background RPC polling). Use in tests that
   * don't want a real network poller running against the test process. Default: false.
   */
  skipIndexerStart?: boolean;
  /**
   * Skip building and mounting the Swagger UI. Use to keep the documentation endpoints
   * absent in production. Default: false.
   */
  skipSwagger?: boolean;
  /**
   * Middleware mounted in front of `/api/docs*` — in practice HTTP basic auth. Mounting it
   * here rather than in `main.ts` keeps protection attached to the routes it guards, so a
   * test that calls `configureApp` cannot end up serving public docs.
   */
  docsAuth?: RequestHandler;
}

/**
 * Applies the full HTTP-level stack — Helmet, body-size limits, the global exception
 * filter, the metrics interceptor, CORS, the global validation pipe, and the Swagger UI —
 * to an already-created Nest application. This is the single source of truth for that
 * stack: `main.ts` calls it to boot the real server, and tests call it (with
 * `skipSentryInit`/`skipIndexerStart`) so they exercise the same behavior instead of
 * hand-rolling a partial copy.
 */
export function configureApp(app: INestApplication, options: ConfigureAppOptions = {}): void {
  // Security headers before any other middleware. `createSecurityHeadersMiddleware()` applies
  // the strict API CSP (`default-src 'none'`, no `unsafe-inline`) to every route and the
  // relaxed one only to `/api/docs*`, which is what Swagger needs to render.
  //
  // A single blanket `helmet({ ...relaxed... })` used to be applied to all routes here, which
  // meant every JSON API response shipped a policy allowing inline script — and
  // `security-headers.spec.ts`, which asserts the strict per-path behavior, never exercised
  // this function so the regression went unnoticed.
  app.use(createSecurityHeadersMiddleware());

  // Explicit body-size limit for JSON payloads.
  // The IPFS pin endpoint accepts base64-encoded deliverable content; 10 MB decoded
  // encodes to ~13.6 MB base64, so a 15 MB JSON limit gives adequate headroom while
  // still providing a deliberate, reviewed DoS control rather than relying on Express's
  // implicit default. Override via BODY_LIMIT_MB env var if your use case requires it.
  const bodyLimit = `${config.BODY_LIMIT_MB}mb`;
  app.use(express.json({ limit: bodyLimit }));
  app.use(express.urlencoded({ extended: true, limit: bodyLimit }));

  // Initialize Sentry via the injectable service so it shares the same instance
  const sentryService = app.get(SentryService);
  if (!options.skipSentryInit) {
    sentryService.init();
  }

  // Register global exception filter — captures 5xx errors to Sentry, tags with correlationId
  const correlationIdStore = app.get(CorrelationIdStore);
  app.useGlobalFilters(new SentryExceptionFilter(sentryService, correlationIdStore));

  // Register global request timeout interceptor (runs before metrics so timeout errors are recorded)
  const requestTimeoutInterceptor = app.get(RequestTimeoutInterceptor);
  app.useGlobalInterceptors(requestTimeoutInterceptor);

  // Register global metrics interceptor
  const metricsInterceptor = app.get(MetricsHttpInterceptor);
  app.useGlobalInterceptors(metricsInterceptor);

  // Enable CORS
  const corsOrigin = config.CORS_ORIGIN;
  const nodeEnv = config.NODE_ENV;

  // Validate CORS configuration in production
  if (nodeEnv === 'production' && (!corsOrigin || corsOrigin.length === 0 || corsOrigin.includes('*'))) {
    logger.error(
      'CORS_ORIGIN must be explicitly set to allowed origins in production (cannot use wildcard with credentials: true)',
    );
    process.exit(1);
  }

  // Warn if using wildcard in any environment (but only fail in production)
  if (corsOrigin?.includes('*') && nodeEnv !== 'production') {
    logger.warn(
      'Using wildcard CORS origin with credentials enabled is a security risk. Set CORS_ORIGIN to a comma-separated list of allowed origins.',
    );
  }

  app.enableCors({
    origin: corsOrigin?.includes('*') ? '*' : corsOrigin || '*',
    credentials: true,
  });

  // Global validation pipe
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: true,
    }),
  );

  // Enable API Versioning
  app.enableVersioning({
    type: VersioningType.URI,
    defaultVersion: '1',
  });

  if (!options.skipSwagger) {
    if (options.docsAuth) {
      app.use(['/api/docs', '/api/docs-json'], options.docsAuth);
    }
    setupSwaggerUi(app, buildOpenApiDocument(app));
  }

  if (!options.skipIndexerStart) {
    const indexer = app.get(SorobanEventIndexerService);
    indexer.start();
  }
}

/**
 * Builds the OpenAPI document for `app` without mounting any routes. Exposed separately
 * from `configureApp` so `scripts/export-openapi.ts` can generate `openapi.json` from a
 * Nest application context without listening on a port.
 */
export function buildOpenApiDocument(app: INestApplication): OpenAPIObject {
  const swaggerConfig = new DocumentBuilder()
    .setTitle('TrustFlow API')
    .setDescription(
      'The TrustFlow Backend API provides off-chain services for the TrustFlow gig economy platform. ' +
        'It handles authentication, escrow management, webhook dispatch, and Stellar blockchain integration.\n\n' +
        '**Wallet-Signature Authentication:** Challenge-response auth using Stellar wallet signatures. ' +
        'Challenges use single-use nonces with 60-second TTLs and are stored in a distributed Redis nonce store ' +
        'that blocks replay attacks across all API nodes. Note: several endpoints (e.g. Escrow, Webhooks) ' +
        'are currently unauthenticated and rely on IP-scoped rate limiting only — per-wallet limits do not ' +
        'apply to them. See individual endpoint docs for the applicable security model.\n\n' +
        '**Error Monitoring:** All 5xx errors and unhandled exceptions are automatically captured by Sentry ' +
        'for real-time alerting and triage. Set the `SENTRY_DSN` environment variable to enable.\n\n' +
        '**Rate Limiting:** Authenticated endpoints benefit from coordinated per-IP and per-wallet ' +
        'distributed token-bucket limits across API nodes. The wallet identity used for the ' +
        'per-wallet bucket is always derived from a cryptographically verified JWT (never from ' +
        'request body/query/param values, which a client fully controls) — a request with a ' +
        'missing or invalid bearer token falls back to IP-scoped limiting only. Repeated limit violations are tracked in a ' +
        'sliding abuse window and can trigger temporary lockouts. When a request is rejected, the API ' +
        'returns `429 Too Many Requests` with `retryAfter` and `scope` fields. Health check (`/health`) ' +
        'and metrics (`/metrics`) endpoints are exempt from rate limiting. Requires `REDIS_URL` to be configured.\n\n' +
        '**Transactional Outbox:** Gig state changes and their domain events are committed in the same ' +
        'Redis MULTI/EXEC transaction. A background relay delivers each event at least once to the WebSocket ' +
        'gateway channel, worker queue, and registered webhooks. Consumers must deduplicate by `dedupKey`.',
    )
    .setVersion('1.0.0')
    .setContact('TrustFlow Protocol', 'https://trustflow.xyz', 'support@trustflow.xyz')
    .setLicense('MIT', 'https://opensource.org/licenses/MIT')
    .addServer(config.API_URL, 'Development')
    .addServer('https://api.trustflow.xyz', 'Production')
    .addBearerAuth(
      {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
        description: 'Enter JWT token obtained from /auth/login endpoint',
      },
      'JWT-auth',
    )
    .addTag('Authentication', 'Wallet-based JWT authentication endpoints')
    .addTag(
      'Escrow',
      'Escrow vault management and dispute resolution. ' +
        'Note: these endpoints are currently unauthenticated — rate limiting is IP-scoped only.',
    )
    .addTag(
      'Webhooks',
      'Webhook registration and management. ' +
        'Note: register/unregister endpoints are currently unauthenticated — rate limiting is IP-scoped only.',
    )
    .addTag('Outbox', 'Durable at-least-once domain event delivery and relay operations')
    .addTag('Monitoring', 'Health checks and metrics')
    .addTag(
      'IPFS Pinning',
      'Multi-provider IPFS pinning with content-hash verification, automatic failover, and a ' +
        'background re-pin worker that restores replication when a provider silently drops a pin.',
    )
    .addTag(
      'Gigs',
      'Gig solicitation postings with a background sweep that automatically expires ' +
        'solicitations left unanswered past their response deadline.',
    )
    .addTag(
      'Admin',
      'Read-only system analytics for protocol admins — escrow, gig, dispute, reputation, ' +
        'migration, and reconciliation state aggregated into a dashboard view. Restricted to ' +
        'wallet addresses listed in `ADMIN_ADDRESSES`.',
    )
    .build();

  return SwaggerModule.createDocument(app, swaggerConfig);
}

/** Mounts the interactive Swagger UI (`/api/docs`) and the raw JSON document (`/api/docs-json`). */
export function setupSwaggerUi(app: INestApplication, document: OpenAPIObject): void {
  SwaggerModule.setup('api/docs', app, document, {
    customSiteTitle: 'TrustFlow API Documentation',
    customfavIcon: 'https://trustflow.xyz/favicon.ico',
    customCss: '.swagger-ui .topbar { display: none }',
    swaggerOptions: {
      persistAuthorization: true,
      tagsSorter: 'alpha',
      operationsSorter: 'alpha',
    },
  });

  SwaggerModule.setup('api/docs-json', app, document, {
    jsonDocumentUrl: '/api/docs-json',
  });
}
