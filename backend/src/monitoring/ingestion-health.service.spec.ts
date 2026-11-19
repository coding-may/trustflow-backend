import { IngestionHealthService } from './ingestion-health.service';

describe('IngestionHealthService', () => {
  let service: IngestionHealthService;

  beforeEach(() => {
    service = new IngestionHealthService();
  });

  it('reports healthy before any poll has ever reported in', () => {
    expect(service.isHealthy()).toBe(true);
    expect(service.getLastSuccessfulPollAt()).toBeNull();
  });

  it('reports healthy right after a successful poll', () => {
    service.recordSuccessfulPoll(5000);

    expect(service.isHealthy()).toBe(true);
    expect(service.getLastSuccessfulPollAt()).toBeInstanceOf(Date);
  });

  it('reports unhealthy once the last successful poll is older than the stale threshold', () => {
    service.recordSuccessfulPoll(5000);
    const realNow = Date.now;
    Date.now = jest.fn(() => realNow() + 5000 * 3 + 1);

    try {
      expect(service.isHealthy()).toBe(false);
    } finally {
      Date.now = realNow;
    }
  });

  it('stays healthy within the stale threshold (a poller that is merely a little slow)', () => {
    service.recordSuccessfulPoll(5000);
    const realNow = Date.now;
    Date.now = jest.fn(() => realNow() + 5000 * 2);

    try {
      expect(service.isHealthy()).toBe(true);
    } finally {
      Date.now = realNow;
    }
  });
});
