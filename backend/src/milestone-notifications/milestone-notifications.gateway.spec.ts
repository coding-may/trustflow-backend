import { Test, TestingModule } from '@nestjs/testing';
import { Server, Socket } from 'socket.io';
import { MilestoneNotificationsGateway } from './milestone-notifications.gateway';
import { EventDedupService } from './event-dedup.service';
import { REDIS_CLIENT } from '../common/redis/redis.module';
import { OUTBOX_GATEWAY_CHANNEL } from '../outbox/outbox-publisher.service';
import { OutboxEvent } from '../outbox/outbox.types';
import { resetEnvConfig, validateEnv } from '../config/env.config';

// The subscribe handlers read WS_MAX_ROOMS_PER_CLIENT from the validated config.
validateEnv();

/**
 * #646 — a milestone event must reach a connected client exactly once, no matter how many
 * backend replicas are running.
 *
 * The assertion is made on `server.to(room).emit(...)` calls rather than on a live socket.io
 * client. That is deliberate: the bug is about *how many times the gateway broadcasts*, and a
 * mock server observes that directly and deterministically. (The previous version of this spec
 * drove a real socket.io client over a real port; it could not run at all, because
 * `socket.io-client` was missing from `package.json`, so the gateway has had no working test
 * coverage.)
 */

/** One recorded broadcast. */
interface Emission {
  room: string;
  event: string;
  payload: unknown;
}

/**
 * Stands in for the socket.io `Server`. `to()` returns a broadcaster, so a caller chain reads
 * the same as production while the emit is recorded for assertion.
 */
function createMockServer(): { server: Server; emissions: Emission[]; closed: () => boolean } {
  const emissions: Emission[] = [];
  let closed = false;

  const broadcaster = (room: string) => ({
    emit: (event: string, payload: unknown) => {
      emissions.push({ room, event, payload });
      return true;
    },
  });

  const server = {
    to: jest.fn((room: string) => broadcaster(room)),
    emit: jest.fn(),
    close: jest.fn(() => {
      closed = true;
    }),
  } as unknown as Server;

  return { server, emissions, closed: () => closed };
}

/** Redis stand-in covering the pub/sub subscriber and the dedup claim. */
function createFakeRedis(claim: () => boolean = () => true) {
  return {
    duplicate: jest.fn(),
    on: jest.fn(),
    subscribe: jest.fn(),
    unsubscribe: jest.fn(),
    disconnect: jest.fn(),
    set: jest.fn(() => Promise.resolve(claim() ? 'OK' : null)),
  };
}

function outboxEvent(overrides: Partial<OutboxEvent> = {}): OutboxEvent {
  return {
    id: 'evt-1',
    dedupKey: 'dedup-1',
    type: 'gig.accepted',
    aggregateType: 'gig',
    aggregateId: 'gig-123',
    payload: { success: true },
    status: 'pending',
    attempts: 0,
    nextAttemptAt: 0,
    createdAt: '',
    ...overrides,
  };
}

interface Harness {
  gateway: MilestoneNotificationsGateway;
  server: Server;
  emissions: Emission[];
  serverClosed: () => boolean;
  /** Feeds one event in as Redis pub/sub would, then waits for the gateway to settle. */
  dispatch: (event: Partial<OutboxEvent>) => Promise<void>;
  /** Feeds a raw payload string, for exercising the malformed-input path. */
  dispatchRaw: (message: string) => Promise<void>;
  fakeRedis: ReturnType<typeof createFakeRedis>;
}

async function startHarness(claim: () => boolean = () => true): Promise<Harness> {
  const fakeRedis = createFakeRedis(claim);
  let messageListener: (channel: string, message: string) => void = () => undefined;

  fakeRedis.duplicate.mockReturnValue(fakeRedis);
  fakeRedis.on.mockImplementation(
    (event: string, cb: (channel: string, message: string) => void) => {
      if (event === 'message') messageListener = cb;
    },
  );
  fakeRedis.subscribe.mockImplementation((_channel: string, cb?: (err: Error | null) => void) => {
    cb?.(null);
  });
  fakeRedis.unsubscribe.mockResolvedValue(1);

  const moduleFixture: TestingModule = await Test.createTestingModule({
    providers: [
      MilestoneNotificationsGateway,
      EventDedupService,
      { provide: REDIS_CLIENT, useValue: fakeRedis },
    ],
  }).compile();

  const gateway = moduleFixture.get<MilestoneNotificationsGateway>(MilestoneNotificationsGateway);
  gateway.onModuleInit();

  const { server, emissions, closed } = createMockServer();
  // The `@WebSocketServer()` property is normally injected by the Nest adapter.
  gateway.server = server;

  const send = async (message: string) => {
    messageListener(OUTBOX_GATEWAY_CHANNEL, message);
    // Claiming an event is a promise, so the emit lands after the listener returns.
    await gateway.whenIdle();
  };

  return {
    gateway,
    server,
    emissions,
    serverClosed: closed,
    fakeRedis,
    dispatch: (event: Partial<OutboxEvent>) => send(JSON.stringify(outboxEvent(event))),
    dispatchRaw: send,
  };
}

/** A connected client, as far as the gateway is concerned. */
function fakeSocket(id: string): Socket {
  return {
    id,
    emit: jest.fn(),
    disconnect: jest.fn(),
    join: jest.fn(),
    leave: jest.fn(),
  } as unknown as Socket;
}

describe('MilestoneNotificationsGateway', () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await startHarness();
  });

  afterEach(async () => {
    await harness.gateway.onModuleDestroy();
  });

  it('emits to the room named after the event aggregate', async () => {
    await harness.dispatch({ aggregateId: 'gig-123', type: 'gig.accepted' });

    expect(harness.emissions).toEqual([
      {
        room: 'gig:gig-123',
        event: 'milestone:update',
        payload: { v: 1, type: 'gig.accepted', data: { success: true }, eventId: 'dedup-1' },
      },
    ]);
  });

  it('relays deliverable events on their own channel', async () => {
    await harness.dispatch({
      aggregateId: 'gig-9',
      type: 'deliverable.uploaded',
      payload: { file: 'a.pdf' },
    });

    expect(harness.emissions).toEqual([
      {
        room: 'gig:gig-9',
        event: 'deliverable:uploaded',
        payload: { v: 1, type: 'deliverable.uploaded', data: { file: 'a.pdf' } },
      },
    ]);
  });

  it('ignores event types it does not relay', async () => {
    await harness.dispatch({ aggregateId: 'gig-1', type: 'escrow.funded' });

    expect(harness.emissions).toEqual([]);
  });

  it('tracks connected clients and puts them in the right room', () => {
    const client = fakeSocket('socket-1');

    harness.gateway.handleConnection(client);
    const ack = harness.gateway.handleSubscribeGig(client, { gigId: 'gig-77' });

    expect(ack).toEqual({ event: 'subscribed', data: { gigId: 'gig-77' } });
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(client.join).toHaveBeenCalledWith('gig:gig-77');

    const unsub = harness.gateway.handleUnsubscribeGig(client, { gigId: 'gig-77' });
    expect(unsub).toEqual({ event: 'unsubscribed', data: { gigId: 'gig-77' } });
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(client.leave).toHaveBeenCalledWith('gig:gig-77');

    harness.gateway.handleDisconnect(client);
  });

  it('unsubscribes and disconnects the Redis subscriber on destroy', async () => {
    await harness.gateway.onModuleDestroy();

    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(harness.fakeRedis.unsubscribe).toHaveBeenCalledWith(OUTBOX_GATEWAY_CHANNEL);
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(harness.fakeRedis.disconnect).toHaveBeenCalled();
  });

  it('tells connected clients why they are being dropped, then closes them', async () => {
    const client = fakeSocket('socket-drain');
    harness.gateway.handleConnection(client);

    await harness.gateway.drainClients('rolling restart');

    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(client.emit).toHaveBeenCalledWith('server:shutdown', {
      reason: 'rolling restart',
      reconnect: true,
    });
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(client.disconnect).toHaveBeenCalledWith(true);
    expect(harness.serverClosed()).toBe(true);
  });

  it('refuses a client that connects after a drain has begun', async () => {
    await harness.gateway.drainClients('rolling restart');
    const late = fakeSocket('socket-late');

    harness.gateway.handleConnection(late);

    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(late.emit).toHaveBeenCalledWith('server:shutdown', {
      reason: 'server shutting down',
      reconnect: true,
    });
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(late.disconnect).toHaveBeenCalledWith(true);
  });
});

describe('MilestoneNotificationsGateway deduplication (#646)', () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await startHarness();
  });

  afterEach(async () => {
    await harness.gateway.onModuleDestroy();
  });

  it('broadcasts an event exactly once when it is delivered repeatedly', async () => {
    const event = { dedupKey: 'dup-1', aggregateId: 'gig-1' };

    await harness.dispatch(event);
    await harness.dispatch(event);
    await harness.dispatch(event);

    expect(harness.emissions).toHaveLength(1);
  });

  it('broadcasts a distinct event for a distinct key', async () => {
    await harness.dispatch({ dedupKey: 'key-a', aggregateId: 'gig-1', type: 'gig.accepted' });
    await harness.dispatch({ dedupKey: 'key-b', aggregateId: 'gig-1', type: 'gig.completed' });

    expect(harness.emissions.map(e => (e.payload as { type: string }).type)).toEqual([
      'gig.accepted',
      'gig.completed',
    ]);
  });

  it('preserves event order despite the asynchronous dedup claim', async () => {
    // Claiming is an `await`. Without the serialising queue two messages in flight together
    // could resolve out of order and deliver `gig.completed` before `gig.accepted`.
    const types = ['gig.accepted', 'gig.funded', 'gig.completed'];

    const inFlight = types.map(type => harness.dispatch({ dedupKey: `order-${type}`, type }));
    await Promise.all(inFlight);
    await harness.gateway.whenIdle();

    expect(harness.emissions.map(e => (e.payload as { type: string }).type)).toEqual(types);
  });

  it('dedups deliverable events on the same key as milestone events', async () => {
    const event = { dedupKey: 'shared-key', aggregateId: 'gig-2', type: 'deliverable.uploaded' };

    await harness.dispatch(event);
    await harness.dispatch(event);

    expect(harness.emissions).toHaveLength(1);
    expect(harness.emissions[0].event).toBe('deliverable:uploaded');
  });

  it('keeps processing valid events after a malformed message', async () => {
    // A bad payload must not poison the serialising queue and stall every later event.
    await harness.dispatchRaw('{not json');
    await harness.dispatch({ dedupKey: 'after-garbage', aggregateId: 'gig-3' });

    expect(harness.emissions).toHaveLength(1);
  });

  it('stops broadcasting once a drain has begun', async () => {
    await harness.gateway.drainClients('test drain');
    await harness.dispatch({ dedupKey: 'after-drain', aggregateId: 'gig-4' });

    expect(harness.emissions).toEqual([]);
  });

  it('does not emit while another replica holds the claim', async () => {
    // The whole point of #646: with N replicas subscribed to the same channel, only the one
    // that wins the SET NX should broadcast.
    const shared = await startHarness(() => false);
    try {
      await shared.dispatch({ dedupKey: 'owned-elsewhere', aggregateId: 'gig-5' });
      expect(shared.emissions).toEqual([]);
    } finally {
      await shared.gateway.onModuleDestroy();
    }
  });
});

describe('EventDedupService across replicas (#646)', () => {
  /**
   * Two instances sharing one Redis keyspace, standing in for two backend replicas subscribed
   * to the same outbox channel.
   */
  it('lets exactly one replica claim a given event', async () => {
    const store = new Set<string>();
    const redis = {
      set: jest.fn((key: string) => {
        if (store.has(key)) return Promise.resolve(null);
        store.add(key);
        return Promise.resolve('OK' as const);
      }),
    };
    const replicas = [new EventDedupService(redis as never), new EventDedupService(redis as never)];

    const results = await Promise.all([
      replicas[0].claim('evt-shared'),
      replicas[1].claim('evt-shared'),
    ]);

    // Whichever replica wins, the client must receive exactly one broadcast.
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it('uses a 10s TTL so a genuinely new event is not suppressed later', async () => {
    const redis = { set: jest.fn(() => Promise.resolve('OK' as const)) };
    const service = new EventDedupService(redis as never);

    expect(await service.claim('evt-ttl')).toBe(true);
    expect(redis.set).toHaveBeenCalledWith('dedup:gateway:evt-ttl', '1', 'EX', 10, 'NX');
  });

  it('treats an event with no key as broadcastable rather than dropping it', async () => {
    const redis = { set: jest.fn(() => Promise.resolve('OK' as const)) };
    const service = new EventDedupService(redis as never);

    expect(await service.claim('')).toBe(true);
    expect(redis.set).not.toHaveBeenCalled();
  });

  it('broadcasts rather than suppressing when Redis errors', async () => {
    // A duplicated notification is recoverable; a silently dropped milestone update is not.
    const redis = {
      set: jest.fn(() => {
        throw new Error('ECONNREFUSED');
      }),
    };
    const service = new EventDedupService(redis as never, { increment: jest.fn() } as never);

    expect(await service.claim('evt-redis-down')).toBe(true);
    // The local cache still dedups within this replica while Redis is unreachable.
    expect(await service.claim('evt-redis-down')).toBe(false);
  });

  it('dedups per-replica in local mode with no Redis at all', async () => {
    const service = new EventDedupService(null);

    expect(await service.claim('evt-local')).toBe(true);
    expect(await service.claim('evt-local')).toBe(false);
  });

  it('counts claims and duplicates', async () => {
    const redis = { set: jest.fn(() => Promise.resolve('OK' as const)) };
    const metrics = { increment: jest.fn() };
    const service = new EventDedupService(redis as never, metrics as never);

    await service.claim('evt-metrics');
    await service.claim('evt-metrics');

    expect(metrics.increment).toHaveBeenCalledWith('gateway_event_dedup_claimed_total');
    expect(metrics.increment).toHaveBeenCalledWith('gateway_event_dedup_duplicate_total', {
      source: 'local',
    });
  });
});

/** #393 — subscribe payload validation, per-socket room cap and connection tracking. */
describe('MilestoneNotificationsGateway subscriptions (#393)', () => {
  let gateway: MilestoneNotificationsGateway;

  /** A socket whose `rooms` set reflects join/leave, as Socket.IO's does. */
  function roomSocket(id = 'room-client'): Socket & { rooms: Set<string> } {
    const rooms = new Set<string>([id]);
    return {
      id,
      rooms,
      emit: jest.fn(),
      disconnect: jest.fn(),
      join: jest.fn((room: string) => rooms.add(room)),
      leave: jest.fn((room: string) => rooms.delete(room)),
    } as unknown as Socket & { rooms: Set<string> };
  }

  beforeEach(() => {
    process.env.WS_MAX_ROOMS_PER_CLIENT = '3';
    resetEnvConfig();
    validateEnv();
    gateway = new MilestoneNotificationsGateway(null, {} as EventDedupService);
  });

  afterEach(() => {
    delete process.env.WS_MAX_ROOMS_PER_CLIENT;
    resetEnvConfig();
    validateEnv();
  });

  it.each([
    undefined,
    null,
    'gig-1',
    {},
    { gigId: 42 },
    { gigId: '' },
    { gigId: 'a b' },
    { gigId: 'x'.repeat(65) },
  ])('returns an error ack and joins nothing for payload %p', payload => {
    const client = roomSocket();
    expect(() => gateway.handleSubscribeGig(client, payload)).not.toThrow();
    expect(gateway.handleSubscribeGig(client, payload).event).toBe('error');
    expect(gateway.handleUnsubscribeGig(client, payload).event).toBe('error');
    expect(client.join).not.toHaveBeenCalled();
    expect(client.leave).not.toHaveBeenCalled();
  });

  it('joins a valid gig room', () => {
    const client = roomSocket();
    expect(gateway.handleSubscribeGig(client, { gigId: 'gig-1700000000000-abc123' })).toEqual({
      event: 'subscribed',
      data: { gigId: 'gig-1700000000000-abc123' },
    });
    expect(client.rooms.has('gig:gig-1700000000000-abc123')).toBe(true);
  });

  it('caps the number of rooms one socket may join', () => {
    const client = roomSocket();
    for (let i = 0; i < 3; i++) {
      expect(gateway.handleSubscribeGig(client, { gigId: `gig-${i}` }).event).toBe('subscribed');
    }
    const rejected = gateway.handleSubscribeGig(client, { gigId: 'gig-overflow' });
    expect(rejected).toEqual({
      event: 'error',
      data: { gigId: 'gig-overflow', error: 'room limit reached' },
    });
    expect(client.rooms.has('gig:gig-overflow')).toBe(false);

    // Re-subscribing to an already-joined room is not a new room and is allowed.
    expect(gateway.handleSubscribeGig(client, { gigId: 'gig-0' }).event).toBe('subscribed');

    // Leaving frees a slot.
    gateway.handleUnsubscribeGig(client, { gigId: 'gig-1' });
    expect(gateway.handleSubscribeGig(client, { gigId: 'gig-overflow' }).event).toBe('subscribed');
  });

  it('tracks connections and removes them on disconnect', () => {
    const a = roomSocket('a');
    const b = roomSocket('b');
    gateway.handleConnection(a);
    gateway.handleConnection(b);
    expect(gateway.getStats().connections).toBe(2);

    gateway.handleDisconnect(a, 'transport close');
    expect(gateway.getStats().connections).toBe(1);
    gateway.handleDisconnect(b);
    expect(gateway.getStats().connections).toBe(0);
  });

  it('counts only gig rooms on the server adapter', () => {
    gateway.server = {
      sockets: {
        adapter: {
          rooms: new Map([
            ['gig:1', new Set()],
            ['gig:2', new Set()],
            ['socket-id', new Set()],
          ]),
        },
      },
    } as unknown as Server;
    expect(gateway.getStats().rooms).toBe(2);
  });

  describe('Milestone reconnect catch-up & duplicate delivery prevention (#929, #930)', () => {
    it('backfills missed events to reconnecting clients with resumeToken (#930)', async () => {
      // Dispatch 2 events to gig-99
      await harness.dispatch({ aggregateId: 'gig-99', dedupKey: 'evt-1', payload: { step: 1 } });
      await harness.dispatch({ aggregateId: 'gig-99', dedupKey: 'evt-2', payload: { step: 2 } });

      const client = fakeSocket('reconnecting-socket');
      harness.gateway.handleConnection(client);

      // Reconnect with resumeToken='evt-1' -> should receive only evt-2
      const ack = harness.gateway.handleSubscribeGig(client, {
        gigId: 'gig-99',
        resumeToken: 'evt-1',
      });

      expect(ack.event).toBe('subscribed');
      expect(ack.data.gigId).toBe('gig-99');
      expect(ack.data.backfilled).toBe(1);
      expect(client.emit).toHaveBeenCalledWith('milestone:update', {
        v: 1,
        type: 'gig.accepted',
        data: { step: 2 },
        eventId: 'evt-2',
      });
    });

    it('drops duplicate direct emits when already claimed (#929)', async () => {
      // First outbox dispatch claims evt-100
      await harness.dispatch({ aggregateId: 'gig-100', dedupKey: 'evt-100', payload: { direct: false } });
      const countAfterOutbox = harness.emissions.length;

      // Duplicate direct emit with the same eventId should be dropped
      await harness.gateway.emitMilestoneUpdate('gig-100', 'gig.accepted', { direct: true }, 'evt-100');
      expect(harness.emissions.length).toBe(countAfterOutbox);
    });
  });
});
