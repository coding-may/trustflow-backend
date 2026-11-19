export enum ReputationEventType {
  ESCROW_COMPLETED = 'escrow_completed',
  DISPUTE_WON = 'dispute_won',
  DISPUTE_LOST = 'dispute_lost',
  DISPUTE_SPLIT = 'dispute_split',
}

/** Domain-neutral outcome a caller (e.g. the dispute saga) maps its own verdict into. */
export type ReputationOutcome = 'won' | 'lost' | 'split';

/** The subset of an escrow's fields the reputation engine needs — kept minimal and decoupled from EscrowService. */
export interface EscrowParties {
  depositor: string;
  beneficiary: string;
  amountXLM: string;
}

export interface ReputationEventLogEntry {
  type: ReputationEventType;
  counterparty: string;
  contribution: number;
  occurredAt: string;
  /** Base weight for `type` before amount scaling/dampening — see REPUTATION_WEIGHTS. */
  baseWeight: number;
  /** sqrt(amountXLM) scaling factor, capped at REPUTATION_MAX_AMOUNT_WEIGHT. */
  amountWeight: number;
  /** Sybil dampening applied for repeated interactions with this counterparty (1 / (1 + priorInteractions)). */
  dampeningFactor: number;
}

/**
 * `ReputationEventLogEntry` plus how much of this single event's contribution remains after
 * decaying it from its own `occurredAt` to "now" — for transparency/audit purposes only
 * (#989). The materialized score itself is never decayed per event; it decays as one
 * aggregate from `lastUpdatedAt` (see the `decay()` doc comment on `ReputationService`), so
 * this is an illustrative approximation of "how much this event still counts for", not a
 * stored ledger value, and the sum of `decayedContribution` across events will not exactly
 * equal the current `score`.
 */
export interface ReputationBreakdownEntry extends ReputationEventLogEntry {
  decayedContribution: number;
}

export interface ReputationScoreBreakdown {
  address: string;
  score: number;
  eventCount: number;
  lastUpdatedAt: string;
  events: ReputationBreakdownEntry[];
}

/** Materialized, incrementally-updated score record for a single address. */
export interface ReputationScoreRecord {
  address: string;
  score: number;
  eventCount: number;
  /** Interaction count per counterparty — drives Sybil dampening (diminishing returns on repeated pairs). */
  counterpartyCounts: Record<string, number>;
  recentEvents: ReputationEventLogEntry[];
  lastUpdatedAt: string;
}

export interface ReputationScoreView {
  address: string;
  score: number;
  eventCount: number;
  distinctCounterparties: number;
  recentEvents: ReputationEventLogEntry[];
  lastUpdatedAt: string;
}

/**
 * Score halves every 90 days without new activity, so stale history stops dominating current
 * trust. 90 days was picked as a middle ground for a freelance/gig marketplace: long enough that
 * a quiet address (between contracts) isn't unfairly zeroed out, short enough that reputation
 * earned years ago doesn't keep protecting an address that's gone silent or turned bad. Tune by
 * changing this single constant — every decay computation derives from it, nothing else to touch.
 */
export const REPUTATION_DECAY_HALF_LIFE_MS = 90 * 24 * 60 * 60 * 1000;

/** How many of an address's most recent events are kept for the API's audit trail; older ones are evicted (score itself is unaffected — it's already folded into the materialized total). */
export const REPUTATION_RECENT_EVENTS_LIMIT = 20;

/**
 * Base weight per event type, before amount scaling and Sybil dampening.
 * DISPUTE_LOST outweighs a clean ESCROW_COMPLETED by 2x and DISPUTE_WON by 5x so that
 * winning a dispute never nets a better outcome than simply not causing one, and losing one
 * is punished more than an equivalent completion rewards — bad actors should lose reputation
 * faster than good actors can rebuild it. DISPUTE_SPLIT is a small penalty to both sides since
 * neither party was fully vindicated. Tune these four numbers directly; they're independent of
 * amount scaling and dampening, which are applied multiplicatively on top.
 */
export const REPUTATION_WEIGHTS: Record<ReputationEventType, number> = {
  [ReputationEventType.ESCROW_COMPLETED]: 5,
  [ReputationEventType.DISPUTE_WON]: 2,
  [ReputationEventType.DISPUTE_LOST]: -10,
  [ReputationEventType.DISPUTE_SPLIT]: -2,
};

/**
 * Caps how much a single high-value escrow can scale a contribution (amountWeight = sqrt(amountXLM),
 * capped here). Square-root rather than linear scaling so a 10,000 XLM escrow counts for meaningfully
 * more than a 100 XLM one without letting a single whale transaction single-handedly dominate an
 * address's score; the cap puts a hard ceiling under that same goal even for extreme amounts.
 */
export const REPUTATION_MAX_AMOUNT_WEIGHT = 10;

export const REPUTATION_LEADERBOARD_DEFAULT_LIMIT = 50;
