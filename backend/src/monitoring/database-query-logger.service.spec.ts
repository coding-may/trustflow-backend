import { Test, TestingModule } from '@nestjs/testing';
import { DatabaseQueryLoggerService } from './database-query-logger.service';
import { MetricsService } from './metrics.service';

describe('DatabaseQueryLoggerService', () => {
  let service: DatabaseQueryLoggerService;
  let metricsService: MetricsService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [DatabaseQueryLoggerService, MetricsService],
    }).compile();

    service = module.get<DatabaseQueryLoggerService>(DatabaseQueryLoggerService);
    metricsService = module.get<MetricsService>(MetricsService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  it('should register database_query_duration_seconds histogram on construction', () => {
    const metrics = metricsService.toPrometheus();
    expect(metrics).toContain('database_query_duration_seconds');
    expect(metrics).toContain('TYPE database_query_duration_seconds histogram');
  });

  describe('logQuery', () => {
    it('should emit histogram metric for all queries', () => {
      service.logQuery('SELECT * FROM users', 50, 'primary');
      const metrics = metricsService.toPrometheus();
      expect(metrics).toContain('database_query_duration_seconds');
    });

    it('should log warning for slow queries (>200ms)', () => {
      const logSpy = jest.spyOn(service['logger'], 'warn');
      service.logQuery('SELECT * FROM large_table', 250, 'primary');
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Slow query detected'));
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('250.00ms'));
    });

    it('should not log warning for fast queries (<200ms)', () => {
      const logSpy = jest.spyOn(service['logger'], 'warn');
      service.logQuery('SELECT 1', 50, 'primary');
      expect(logSpy).not.toHaveBeenCalled();
    });

    it('should increment slow_queries counter for slow queries', () => {
      service.logQuery('SELECT * FROM large_table', 300, 'replica');
      const metrics = metricsService.toPrometheus();
      expect(metrics).toContain('database_slow_queries_total');
      expect(metrics).toContain('pool="replica"');
    });

    it('should sanitize query strings before logging', () => {
      const logSpy = jest.spyOn(service['logger'], 'warn');
      service.logQuery(
        "SELECT * FROM users WHERE email = 'sensitive@example.com' AND id = 123",
        250,
        'primary',
      );
      expect(logSpy).toHaveBeenCalledWith(expect.not.stringContaining('sensitive@example.com'));
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('?'));
    });

    it('should truncate very long queries', () => {
      const longQuery = 'SELECT ' + 'column,'.repeat(200) + ' FROM table';
      const logSpy = jest.spyOn(service['logger'], 'warn');
      service.logQuery(longQuery, 250, 'primary');
      expect(logSpy).toHaveBeenCalledWith(expect.stringMatching(/\.\.\./));
    });
  });
});
