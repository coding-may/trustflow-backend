import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, Controller, Get } from '@nestjs/common';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import request from 'supertest';
import {
  createDocsBasicAuth,
  createSecurityHeadersMiddleware,
  isSwaggerEnabled,
} from './common/http/docs-security';
import { SentryModule } from './sentry/sentry.module';
import { LoggingModule } from './common/logging/logging.module';
import { MonitoringModule } from './monitoring/monitoring.module';

@Controller('health')
class HealthController {
  @Get()
  getHealth() {
    return { status: 'ok' };
  }
}

describe('Security Headers (Helmet)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      // SentryModule/LoggingModule/MonitoringModule provide the SentryService,
      // CorrelationIdStore and MetricsHttpInterceptor that configureApp() wires up —
      // the same stack a real request goes through, rather than a hand-rolled subset.
      imports: [SentryModule, LoggingModule, MonitoringModule],
      controllers: [HealthController],
    }).compile();

    app = moduleFixture.createNestApplication();

    // The exact middleware main.ts installs.
    app.use(createSecurityHeadersMiddleware());

    const config = new DocumentBuilder().setTitle('Test API').setVersion('1.0.0').build();
    const document = SwaggerModule.createDocument(app, config);
    SwaggerModule.setup('api/docs', app, document);

    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('returns standard Helmet security headers on API responses', async () => {
    const res = await request(app.getHttpServer()).get('/v1/health').expect(200);

    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['strict-transport-security']).toBeDefined();
    expect(res.headers['x-dns-prefetch-control']).toBe('off');
    expect(res.headers['x-download-options']).toBe('noopen');
    expect(res.headers['x-permitted-cross-domain-policies']).toBe('none');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
  });

  it('applies a strict CSP to API responses', async () => {
    const res = await request(app.getHttpServer()).get('/v1/health').expect(200);

    const csp = res.headers['content-security-policy'];
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toContain('unsafe-inline');
  });

  it('applies the relaxed Swagger CSP only on /api/docs', async () => {
    const res = await request(app.getHttpServer()).get('/v1/api/docs/').expect(200);

    expect(res.text).toContain('swagger-ui');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    const csp = res.headers['content-security-policy'];
    expect(csp).toContain("script-src 'self' 'unsafe-inline'");
    expect(csp).toContain("style-src 'self' 'unsafe-inline'");
    expect(csp).toContain("img-src 'self' data: https:");
  });
});

describe('docs availability and protection', () => {
  it('isSwaggerEnabled defaults by environment and honours the override', () => {
    expect(isSwaggerEnabled({ NODE_ENV: 'development' })).toBe(true);
    expect(isSwaggerEnabled({ NODE_ENV: 'production' })).toBe(false);
    expect(isSwaggerEnabled({ NODE_ENV: 'production', SWAGGER_ENABLED: 'true' })).toBe(true);
    expect(isSwaggerEnabled({ NODE_ENV: 'development', SWAGGER_ENABLED: 'false' })).toBe(false);
  });

  it('returns 404 for the docs routes when Swagger is not set up', async () => {
    const moduleFixture = await Test.createTestingModule({
      controllers: [HealthController],
    }).compile();
    const app = moduleFixture.createNestApplication();
    await app.init();
    await request(app.getHttpServer()).get('/v1/api/docs').expect(404);
    await request(app.getHttpServer()).get('/v1/api/docs-json').expect(404);
    await app.close();
  });

  it('basic auth guards the docs when credentials are configured', async () => {
    const moduleFixture = await Test.createTestingModule({
      controllers: [HealthController],
    }).compile();
    const app = moduleFixture.createNestApplication();
    const auth = createDocsBasicAuth('u', 'p');
    expect(auth).toBeDefined();
    app.use(['/api/docs', '/api/docs-json'], auth!);
    const document = SwaggerModule.createDocument(app, new DocumentBuilder().build());
    SwaggerModule.setup('api/docs', app, document, { jsonDocumentUrl: '/api/docs-json' });
    await app.init();
    const server = app.getHttpServer();
    await request(server).get('/v1/api/docs-json').expect(401);
    await request(server).get('/v1/api/docs-json').auth('u', 'wrong').expect(401);
    await request(server).get('/v1/api/docs-json').auth('u', 'p').expect(200);
    await app.close();
  });

  it('createDocsBasicAuth is undefined without credentials', () => {
    expect(createDocsBasicAuth(undefined, undefined)).toBeUndefined();
  });
});
