/** Lifecycle status of a gig solicitation. */
export enum GigStatus {
  /** Posted and awaiting a response. */
  OPEN = 'open',
  /** A responder accepted before the response window elapsed. */
  ACCEPTED = 'accepted',
  /** Nobody accepted before the response window elapsed. */
  EXPIRED = 'expired',
  /** Withdrawn by the creator before the response window elapsed. */
  CANCELLED = 'cancelled',
}

/** Predefined categories for classifying gig solicitations. */
export enum GigCategory {
  DEVELOPMENT = 'development',
  DESIGN = 'design',
  MARKETING = 'marketing',
  WRITING = 'writing',
  AUDIT = 'audit',
  TRANSLATION = 'translation',
  CONSULTING = 'consulting',
  OTHER = 'other',
}

export interface Gig {
  id: string;
  creator: string;
  title: string;
  budgetXLM: string;
  status: GigStatus;
  createdAt: string;
  /** Deadline by which the gig must be accepted, after which the expiry sweep marks it EXPIRED. */
  respondBy: string;
  acceptedBy?: string;
  acceptedAt?: string;
  expiredAt?: string;
  cancelledAt?: string;
  version: number;
  escrowId?: string;
  reservationId?: string;
}

/** Webhook events emitted by the gig service and expiry sweep worker. */
export const GIG_EVENTS = {
  GIG_CREATED: 'gig.created',
  GIG_ACCEPTED: 'gig.accepted',
  GIG_EXPIRED: 'gig.expired',
  GIG_CANCELLED: 'gig.cancelled',
  GIG_CANCELLED_ACCEPTED: 'gig.cancelled_accepted',
} as const;

export const DEFAULT_RESPONSE_WINDOW_HOURS = 72;
export const DEFAULT_GIG_EXPIRY_SWEEP_INTERVAL_MS = 5 * 60 * 1000;

/** A page of gig search results — see `GigService.search()`. */
export interface PaginatedGigs {
  items: Gig[];
  total: number;
  page: number;
  limit: number;
}

export const DEFAULT_GIG_SEARCH_PAGE = 1;
export const DEFAULT_GIG_SEARCH_LIMIT = 20;
export const MAX_GIG_SEARCH_LIMIT = 100;
/** How long a paginated search result page stays cached in Redis. */
export const DEFAULT_GIG_SEARCH_CACHE_TTL_SECONDS = 30;

export const DEFAULT_GIG_BY_CREATOR_OFFSET = 0;
export const DEFAULT_GIG_BY_CREATOR_LIMIT = 20;
export const MAX_GIG_BY_CREATOR_LIMIT = 100;
