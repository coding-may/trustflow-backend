import { ReputationService } from './reputation.service';
import { ReputationScoreStore } from './reputation-score.store';
import {
  EscrowParties,
  REPUTATION_DECAY_HALF_LIFE_MS,
  REPUTATION_MAX_AMOUNT_WEIGHT,
  REPUTATION_RECENT_EVENTS_LIMIT,
  REPUTATION_WEIGHTS,
  ReputationEventType,
} from './reputation.types';

function makeEscrow(overrides: Partial<EscrowParties> = {}): EscrowParties {
  return {
    depositor: 'GDEPOSITOR',
    beneficiary: 'GBENEFICIARY',
    amountXLM: '100',
    ...overrides,
  };
}

describe('ReputationService', () => {
  let service: ReputationService;
  let store: ReputationScoreStore;

  beforeEach(() => {
    store = new ReputationScoreStore();
    service = new ReputationService(store);
  });

  describe('recordEscrowCompleted', () => {
    it('gives both depositor and beneficiary a positive score', async () => {
      await service.recordEscrowCompleted(makeEscrow());

      expect((await service.getScore('GDEPOSITOR')).score).toBeGreaterThan(0);
      expect((await service.getScore('GBENEFICIARY')).score).toBeGreaterThan(0);
    });

    it('counts one event and one distinct counterparty for a first-time interaction', async () => {
      await service.recordEscrowCompleted(makeEscrow());

      const view = await service.getScore('GDEPOSITOR');
      expect(view.eventCount).toBe(1);
      expect(view.distinctCounterparties).toBe(1);
    });

    it('gives an escrow with zero/invalid amount no contribution', async () => {
      await service.recordEscrowCompleted(makeEscrow({ amountXLM: '0' }));
      expect((await service.getScore('GDEPOSITOR')).score).toBe(0);

      await service.recordEscrowCompleted(makeEscrow({ amountXLM: 'not-a-number' }));
      expect((await service.getScore('GDEPOSITOR')).score).toBe(0);
    });

    it('scales the contribution with amount, up to the configured cap', async () => {
      await service.recordEscrowCompleted(makeEscrow({ amountXLM: '4' }));
      const small = (await service.getScore('GDEPOSITOR')).score;

      const bigStore = new ReputationScoreStore();
      const bigService = new ReputationService(bigStore);
      await bigService.recordEscrowCompleted(makeEscrow({ amountXLM: '10000' }));
      const big = (await bigService.getScore('GDEPOSITOR')).score;

      expect(big).toBeGreaterThan(small);
    });

    it('caps the amount weight for an extremely large amount instead of scaling unbounded', async () => {
      await service.recordEscrowCompleted(makeEscrow({ amountXLM: '1e30' }));

      const expected =
        REPUTATION_WEIGHTS[ReputationEventType.ESCROW_COMPLETED] * REPUTATION_MAX_AMOUNT_WEIGHT;
      const view = await service.getScore('GDEPOSITOR');
      expect(view.score).toBeCloseTo(expected, 5);
      expect(Number.isFinite(view.score)).toBe(true);
    });

    it('gives a negative amount no contribution', async () => {
      await service.recordEscrowCompleted(makeEscrow({ amountXLM: '-50' }));
      expect((await service.getScore('GDEPOSITOR')).score).toBe(0);
    });

    it('gives a non-finite amount (Infinity) no contribution', async () => {
      await service.recordEscrowCompleted(makeEscrow({ amountXLM: 'Infinity' }));
      expect((await service.getScore('GDEPOSITOR')).score).toBe(0);
    });
  });

  describe('Sybil dampening via repeated counterparties', () => {
    it('gives diminishing returns for repeated escrows with the same counterparty', async () => {
      await service.recordEscrowCompleted(makeEscrow());
      const afterFirst = (await service.getScore('GDEPOSITOR')).score;

      await service.recordEscrowCompleted(makeEscrow());
      const afterSecond = (await service.getScore('GDEPOSITOR')).score;

      const firstContribution = afterFirst;
      const secondContribution = afterSecond - afterFirst;

      // Second interaction with the same counterparty is dampened relative to the first.
      expect(secondContribution).toBeGreaterThan(0);
      expect(secondContribution).toBeLessThan(firstContribution);
      // Harmonic dampening: second contribution should be roughly half the first.
      expect(secondContribution).toBeCloseTo(firstContribution / 2, 5);
    });

    it('does not dampen interactions with distinct, one-off counterparties', async () => {
      await service.recordEscrowCompleted(makeEscrow({ depositor: 'GDEP', beneficiary: 'GBEN1' }));
      const afterFirst = (await service.getScore('GDEP')).score;

      await service.recordEscrowCompleted(makeEscrow({ depositor: 'GDEP', beneficiary: 'GBEN2' }));
      const afterSecond = (await service.getScore('GDEP')).score;

      const secondContribution = afterSecond - afterFirst;
      // A brand-new counterparty gets full, undampened weight.
      expect(secondContribution).toBeCloseTo(afterFirst, 5);
    });

    it('never grants reputation for a self-dealing escrow (depositor === beneficiary) (#437)', async () => {
      // The dampening formula alone does NOT neutralise self-dealing — see the class
      // comment above. recordEscrowCompleted() explicitly no-ops in this case instead.
      await service.recordEscrowCompleted(makeEscrow({ depositor: 'GSELF', beneficiary: 'GSELF' }));
      const selfScore = (await service.getScore('GSELF')).score;

      expect(selfScore).toBe(0);
    });
  });

  describe('recordDisputeResolved', () => {
    it('rewards the winner and penalizes the loser', async () => {
      await service.recordDisputeResolved(makeEscrow(), 'won', 'lost');

      expect((await service.getScore('GDEPOSITOR')).score).toBeGreaterThan(0);
      expect((await service.getScore('GBENEFICIARY')).score).toBeLessThan(0);
    });

    it('penalizes losing more heavily than it rewards winning', async () => {
      const winStore = new ReputationScoreStore();
      const winService = new ReputationService(winStore);
      await winService.recordDisputeResolved(makeEscrow(), 'won', 'lost');

      const beneficiaryScore = (await winService.getScore('GBENEFICIARY')).score;
      const depositorScore = (await winService.getScore('GDEPOSITOR')).score;
      expect(Math.abs(beneficiaryScore)).toBeGreaterThan(depositorScore);
    });

    it('applies a mild negative to both parties on a split verdict', async () => {
      await service.recordDisputeResolved(makeEscrow(), 'split', 'split');

      expect((await service.getScore('GDEPOSITOR')).score).toBeLessThan(0);
      expect((await service.getScore('GBENEFICIARY')).score).toBeLessThan(0);
    });

    it('never changes reputation for a self-dealing escrow (depositor === beneficiary) (#437)', async () => {
      await service.recordDisputeResolved(
        makeEscrow({ depositor: 'GSELF', beneficiary: 'GSELF' }),
        'won',
        'lost',
      );

      expect((await service.getScore('GSELF')).score).toBe(0);
    });
  });

  describe('time decay', () => {
    const start = Date.parse('2026-01-01T00:00:00.000Z');

    beforeEach(() => {
      jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
      jest.setSystemTime(start);
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it('halves the score after one full half-life with no new activity', async () => {
      await service.recordEscrowCompleted(makeEscrow());
      const initialScore = (await service.getScore('GDEPOSITOR')).score;

      jest.setSystemTime(start + REPUTATION_DECAY_HALF_LIFE_MS);
      const decayedScore = (await service.getScore('GDEPOSITOR')).score;

      expect(decayedScore).toBeCloseTo(initialScore / 2, 1);
    });

    it('applies decay before adding a new contribution', async () => {
      await service.recordEscrowCompleted(makeEscrow());
      const initialScore = (await service.getScore('GDEPOSITOR')).score;

      jest.setSystemTime(start + REPUTATION_DECAY_HALF_LIFE_MS);
      await service.recordEscrowCompleted(makeEscrow());
      const scoreAfterDecayAndSecondEvent = (await service.getScore('GDEPOSITOR')).score;

      // Decayed first contribution (half) + a dampened (halved, 2nd interaction) second contribution
      // should be noticeably less than simply adding two undamped, undecayed contributions.
      expect(scoreAfterDecayAndSecondEvent).toBeLessThan(initialScore * 2);
    });

    it('does not change score or timestamp when read again immediately', async () => {
      await service.recordEscrowCompleted(makeEscrow());
      const first = await service.getScore('GDEPOSITOR');
      const second = await service.getScore('GDEPOSITOR');

      expect(second.score).toBe(first.score);
    });
  });

  describe('getScore for an unknown address', () => {
    it('returns a zero-value view without persisting a record', async () => {
      const view = await service.getScore('GUNKNOWN');

      expect(view.score).toBe(0);
      expect(view.eventCount).toBe(0);
      expect(view.distinctCounterparties).toBe(0);
      expect(await store.get('GUNKNOWN')).toBeUndefined();
    });
  });

  describe('getTrackedAddressCount', () => {
    it('returns 0 when no address has a materialized record yet', async () => {
      expect(await service.getTrackedAddressCount()).toBe(0);
    });

    it('counts each distinct address with a materialized score once', async () => {
      await service.recordEscrowCompleted(makeEscrow({ depositor: 'G1', beneficiary: 'GB1' }));
      await service.recordEscrowCompleted(makeEscrow({ depositor: 'G1', beneficiary: 'GB2' }));

      // G1 contributed to twice, GB1 and GB2 once each -> 3 distinct addresses tracked.
      expect(await service.getTrackedAddressCount()).toBe(3);
    });
  });

  describe('getLeaderboard', () => {
    it('ranks addresses by score, highest first', async () => {
      await service.recordEscrowCompleted(makeEscrow({ depositor: 'GHIGH', amountXLM: '10000' }));
      await service.recordEscrowCompleted(makeEscrow({ depositor: 'GLOW', amountXLM: '1' }));

      const leaderboard = await service.getLeaderboard();
      const addresses = leaderboard.map(v => v.address);

      expect(addresses.indexOf('GHIGH')).toBeLessThan(addresses.indexOf('GLOW'));
    });

    it('respects the limit parameter', async () => {
      await service.recordEscrowCompleted(makeEscrow({ depositor: 'G1', beneficiary: 'GB1' }));
      await service.recordEscrowCompleted(makeEscrow({ depositor: 'G2', beneficiary: 'GB2' }));
      await service.recordEscrowCompleted(makeEscrow({ depositor: 'G3', beneficiary: 'GB3' }));

      expect(await service.getLeaderboard(2)).toHaveLength(2);
    });

    describe('deterministic tie-breaking', () => {
      it('breaks a score tie by eventCount descending', async () => {
        // GONE: a single amount-36 event (weight 6, dampening 1) -> 5*6*1 = 30.
        // GTWO: two amount-16 events with the *same* counterparty (weight 4 each,
        // dampening 1 then 1/2) -> 5*4*1 + 5*4*0.5 = 30. Same total score, but GTWO
        // has twice the eventCount.
        await service.recordEscrowCompleted(
          makeEscrow({ depositor: 'GONE', beneficiary: 'GBENX', amountXLM: '36' }),
        );
        await service.recordEscrowCompleted(
          makeEscrow({ depositor: 'GTWO', beneficiary: 'GBENY', amountXLM: '16' }),
        );
        await service.recordEscrowCompleted(
          makeEscrow({ depositor: 'GTWO', beneficiary: 'GBENY', amountXLM: '16' }),
        );

        const gOne = await service.getScore('GONE');
        const gTwo = await service.getScore('GTWO');
        expect(gOne.score).toBeCloseTo(gTwo.score, 5);
        expect(gTwo.eventCount).toBeGreaterThan(gOne.eventCount);

        const leaderboard = await service.getLeaderboard();
        const addresses = leaderboard.map(v => v.address).filter(a => a === 'GONE' || a === 'GTWO');
        expect(addresses).toEqual(['GTWO', 'GONE']);
      });

      it('breaks a score and eventCount tie by address ascending', async () => {
        await service.recordEscrowCompleted(makeEscrow({ depositor: 'GZEBRA', beneficiary: 'GX' }));
        await service.recordEscrowCompleted(
          makeEscrow({ depositor: 'GAARDVARK', beneficiary: 'GY' }),
        );

        const leaderboard = await service.getLeaderboard();
        const addresses = leaderboard
          .map(v => v.address)
          .filter(a => a === 'GZEBRA' || a === 'GAARDVARK');
        expect(addresses).toEqual(['GAARDVARK', 'GZEBRA']);
      });
    });
  });

  describe('concurrent updates', () => {
    it('applies every concurrently-fired contribution without losing any', async () => {
      const counterparties = ['GBEN1', 'GBEN2', 'GBEN3', 'GBEN4', 'GBEN5'];

      // Fired without awaiting individually first, the way concurrent request handlers would.
      await Promise.all(
        counterparties.map(beneficiary =>
          service.recordEscrowCompleted(makeEscrow({ depositor: 'GDEP', beneficiary })),
        ),
      );

      const view = await service.getScore('GDEP');
      expect(view.eventCount).toBe(counterparties.length);
      expect(view.distinctCounterparties).toBe(counterparties.length);

      // Every counterparty was distinct and one-off, so every contribution was undampened.
      const expectedScore =
        counterparties.length * REPUTATION_WEIGHTS[ReputationEventType.ESCROW_COMPLETED] * 10;
      expect(view.score).toBeCloseTo(expectedScore, 5);
    });

    it('still dampens correctly when concurrent calls share the same counterparty', async () => {
      // 5 concurrent completions between the same two addresses.
      await Promise.all(
        Array.from({ length: 5 }, () => service.recordEscrowCompleted(makeEscrow())),
      );

      const view = await service.getScore('GDEPOSITOR');
      expect(view.eventCount).toBe(5);

      const perEventWeight = REPUTATION_WEIGHTS[ReputationEventType.ESCROW_COMPLETED] * 10;
      const harmonicSum = 1 + 1 / 2 + 1 / 3 + 1 / 4 + 1 / 5;
      // getScore() rounds to 2 decimal places, so compare at that precision.
      expect(view.score).toBeCloseTo(perEventWeight * harmonicSum, 2);
    });
  });

  describe('recentEvents', () => {
    it('records event type, counterparty, and contribution, capped at the configured limit', async () => {
      await service.recordEscrowCompleted(makeEscrow());
      const view = await service.getScore('GDEPOSITOR');

      expect(view.recentEvents).toHaveLength(1);
      expect(view.recentEvents[0]).toMatchObject({
        type: 'escrow_completed',
        counterparty: 'GBENEFICIARY',
      });
      expect(view.recentEvents[0].contribution).toBeGreaterThan(0);
    });

    it('keeps the most recent event first', async () => {
      await service.recordEscrowCompleted(makeEscrow({ beneficiary: 'GBEN1' }));
      await service.recordEscrowCompleted(makeEscrow({ beneficiary: 'GBEN2' }));

      const view = await service.getScore('GDEPOSITOR');
      expect(view.recentEvents[0].counterparty).toBe('GBEN2');
      expect(view.recentEvents[1].counterparty).toBe('GBEN1');
    });

    it('evicts the oldest entries once more than the configured limit have occurred', async () => {
      const totalEvents = REPUTATION_RECENT_EVENTS_LIMIT + 5;
      for (let i = 0; i < totalEvents; i++) {
        await service.recordEscrowCompleted(makeEscrow({ beneficiary: `GBEN${i}` }));
      }

      const view = await service.getScore('GDEPOSITOR');
      // The log is capped, but the materialized score/eventCount still reflect every event.
      expect(view.recentEvents).toHaveLength(REPUTATION_RECENT_EVENTS_LIMIT);
      expect(view.eventCount).toBe(totalEvents);

      // Most recent first; the earliest 5 counterparties (GBEN0..GBEN4) fell off the log.
      expect(view.recentEvents[0].counterparty).toBe(`GBEN${totalEvents - 1}`);
      expect(view.recentEvents.map(e => e.counterparty)).not.toContain('GBEN0');
      expect(view.recentEvents.map(e => e.counterparty)).not.toContain('GBEN4');
    });
  });

  describe('getScoreBreakdown (#989)', () => {
    it('itemizes each event with its base weight, amount weight, and dampening factor', async () => {
      await service.recordEscrowCompleted(makeEscrow());

      const breakdown = await service.getScoreBreakdown('GDEPOSITOR');

      expect(breakdown.address).toBe('GDEPOSITOR');
      expect(breakdown.events).toHaveLength(1);
      expect(breakdown.events[0]).toMatchObject({
        type: 'escrow_completed',
        counterparty: 'GBENEFICIARY',
        baseWeight: REPUTATION_WEIGHTS[ReputationEventType.ESCROW_COMPLETED],
        dampeningFactor: 1,
      });
      expect(breakdown.events[0].amountWeight).toBeGreaterThan(0);
      expect(breakdown.events[0].amountWeight).toBeLessThanOrEqual(REPUTATION_MAX_AMOUNT_WEIGHT);
      // baseWeight * amountWeight * dampeningFactor reconstructs the stored contribution.
      expect(
        breakdown.events[0].baseWeight *
          breakdown.events[0].amountWeight *
          breakdown.events[0].dampeningFactor,
      ).toBeCloseTo(breakdown.events[0].contribution, 6);
    });

    it('matches the current score from getScore', async () => {
      await service.recordEscrowCompleted(makeEscrow());

      const [view, breakdown] = await Promise.all([
        service.getScore('GDEPOSITOR'),
        service.getScoreBreakdown('GDEPOSITOR'),
      ]);

      expect(breakdown.score).toBe(view.score);
      expect(breakdown.eventCount).toBe(view.eventCount);
    });

    it("decays a long-past event's contribution toward zero in decayedContribution", async () => {
      await service.recordEscrowCompleted(makeEscrow());

      // Backdate the event by one half-life, bypassing the service so this test doesn't
      // depend on mocking Date (new Date() isn't reliably affected by mocking Date.now).
      const record = (await store.get('GDEPOSITOR'))!;
      const backdated = new Date(
        new Date(record.recentEvents[0].occurredAt).getTime() - REPUTATION_DECAY_HALF_LIFE_MS,
      ).toISOString();
      record.recentEvents[0].occurredAt = backdated;
      await store.save(record);

      const breakdown = await service.getScoreBreakdown('GDEPOSITOR');

      // One half-life has elapsed since the event, so its still-counted value should be
      // roughly half of its original, undecayed contribution.
      expect(breakdown.events[0].decayedContribution).toBeCloseTo(
        breakdown.events[0].contribution * 0.5,
        1,
      );
    });

    it('returns an empty breakdown for an address with no history', async () => {
      const breakdown = await service.getScoreBreakdown('GNEW');

      expect(breakdown).toMatchObject({ address: 'GNEW', score: 0, eventCount: 0, events: [] });
    });
  });
});
