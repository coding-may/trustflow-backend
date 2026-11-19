import {
  Inject,
  Injectable,
  NotFoundException,
  ConflictException,
  OnModuleInit,
  Optional,
} from '@nestjs/common';
import { SanitizedLogger } from '../common/logging/sanitized-logger';
import BigNumber from 'bignumber.js';
import { Redis } from 'ioredis';
import { REDIS_CLIENT } from '../common/redis/redis.module';
import { MetricsService } from '../monitoring/metrics.service';
import { UserType, UserStatus } from './user-profile.entity';
import { CreateUserProfileDto, UpdateUserProfileDto, RateUserDto } from './user-profile.dto';
import { randomUUID } from 'crypto';
import { config } from '../config/env.config';
import { parseAmount, normalizeAmount } from '../common/amount';
import { excludeSoftDeleted } from '../common/database/soft-delete';

export interface UserProfile {
  id: string;
  walletAddress: string;
  name: string;
  bio?: string;
  userType: UserType;
  avatarUrl?: string;
  email?: string;
  rating: number;
  ratingCount: number;
  completedJobs: number;
  status: UserStatus;
  skills?: string[];
  socialLinks?: {
    twitter?: string;
    github?: string;
    linkedin?: string;
    website?: string;
  };
  totalEarned?: string;
  totalSpent?: string;
  isVerified: boolean;
  createdAt: string;
  updatedAt: string;
  lastActiveAt?: string;
  deletedAt?: string;
}

const PROFILE_KEY_PREFIX = 'profile:';
const PROFILES_INDEX_KEY = 'profiles:index';
const PROFILES_BY_WALLET_PREFIX = 'profiles:by-wallet:';

/** Emitted (see `GET /metrics`) every time a call falls back to the in-memory store. */
export const USER_PROFILE_PERSISTENCE_FALLBACK_METRIC = 'user_profile_persistence_fallback_total';

/**
 * User profile store. Backed by Redis so profile state survives restarts and is shared across
 * instances — see PERSISTENT_STORAGE_SPIKE.md §2 and its "Follow-up decisions" addendum (#188).
 *
 * `search()` keeps doing an in-process substring scan over `findAll()`'s results — unchanged
 * behavior from before this migration. Redis has no native substring-search equivalent at this
 * data size without adding a separate module (RediSearch), which isn't guaranteed available on
 * every deployment; proper search indexing is a later concern only if profile volume ever makes
 * an in-process scan too slow.
 *
 * Falls back to a process-local Map when Redis is unavailable, logged at `error` level and
 * counted via `USER_PROFILE_PERSISTENCE_FALLBACK_METRIC`.
 */
@Injectable()
export class UserProfileService implements OnModuleInit {
  private readonly logger = new SanitizedLogger(UserProfileService.name);

  /** Fallback stores, only used while Redis is unavailable. */
  private profiles: Map<string, UserProfile> = new Map();
  private walletAddressIndex: Map<string, string> = new Map(); // walletAddress -> profileId

  constructor(
    @Optional() @Inject(REDIS_CLIENT) private readonly redis: Redis | null = null,
    @Optional() private readonly metrics?: MetricsService,
  ) {}

  onModuleInit(): void {
    if (!this.redis && config.NODE_ENV === 'production') {
      throw new Error(
        'UserProfileService requires REDIS_URL to be configured in production — refusing to ' +
          'start with per-instance in-memory storage, which would silently diverge across instances.',
      );
    }
  }

  /**
   * Create a new user profile
   */
  async create(dto: CreateUserProfileDto): Promise<UserProfile> {
    const existing = await this.tryFindByWalletAddress(dto.walletAddress);
    if (existing) {
      throw new ConflictException('Profile with this wallet address already exists');
    }

    const id = randomUUID();
    const now = new Date().toISOString();

    const profile: UserProfile = {
      id,
      walletAddress: dto.walletAddress,
      name: dto.name,
      bio: dto.bio,
      userType: dto.userType,
      avatarUrl: dto.avatarUrl,
      email: dto.email,
      rating: 0,
      ratingCount: 0,
      completedJobs: 0,
      status: UserStatus.ACTIVE,
      skills: dto.skills,
      socialLinks: dto.socialLinks,
      totalEarned: '0',
      totalSpent: '0',
      isVerified: false,
      createdAt: now,
      updatedAt: now,
      lastActiveAt: now,
    };

    if (this.redis) {
      try {
        const results = await this.redis
          .multi()
          .set(this.profileKey(id), JSON.stringify(profile))
          .sadd(PROFILES_INDEX_KEY, id)
          .set(this.walletKey(dto.walletAddress), id)
          .exec();
        this.assertTransactionOk(results);
        return profile;
      } catch (err) {
        this.logFallback('create', err);
      }
    }

    this.profiles.set(id, profile);
    this.walletAddressIndex.set(dto.walletAddress, id);
    return profile;
  }

  /**
   * Find profile by ID
   */
  async findById(id: string): Promise<UserProfile> {
    const profile = await this.tryFindById(id);
    if (!profile) {
      throw new NotFoundException('User profile not found');
    }
    return profile;
  }

  /**
   * Find profile by wallet address
   */
  async findByWalletAddress(walletAddress: string): Promise<UserProfile> {
    const profile = await this.tryFindByWalletAddress(walletAddress);
    if (!profile) {
      throw new NotFoundException('User profile not found');
    }
    return profile;
  }

  /**
   * Get all profiles with optional filters
   */
  async findAll(filters?: {
    userType?: UserType;
    status?: UserStatus;
    minRating?: number;
    offset?: number;
    limit?: number;
  }): Promise<{ data: UserProfile[]; total: number }> {
    let profiles = excludeSoftDeleted(await this.fetchAll());

    if (filters?.userType) {
      profiles = profiles.filter(
        p => p.userType === filters.userType || p.userType === UserType.BOTH,
      );
    }

    if (filters?.status) {
      profiles = profiles.filter(p => p.status === filters.status);
    }

    if (filters?.minRating !== undefined) {
      profiles = profiles.filter(p => p.rating >= (filters.minRating ?? 0));
    }

    const total = profiles.length;
    const offset = filters?.offset ?? 0;
    const limit = filters?.limit ?? 20;
    const data = profiles.slice(offset, offset + limit);
    return { data, total };
  }

  /**
   * Update a user profile
   */
  async update(id: string, dto: UpdateUserProfileDto): Promise<UserProfile> {
    const profile = await this.findById(id);

    // Update fields
    if (dto.name !== undefined) profile.name = dto.name;
    if (dto.bio !== undefined) profile.bio = dto.bio;
    if (dto.userType !== undefined) profile.userType = dto.userType;
    if (dto.avatarUrl !== undefined) profile.avatarUrl = dto.avatarUrl;
    if (dto.email !== undefined) profile.email = dto.email;
    if (dto.skills !== undefined) profile.skills = dto.skills;
    if (dto.socialLinks !== undefined) {
      profile.socialLinks = { ...profile.socialLinks, ...dto.socialLinks };
    }
    if (dto.status !== undefined) profile.status = dto.status;

    profile.updatedAt = new Date().toISOString();
    await this.persist(profile);
    return profile;
  }

  /**
   * Delete a user profile
   */
  async delete(id: string): Promise<void> {
    const profile = await this.findById(id);

    if (this.redis) {
      try {
        const results = await this.redis
          .multi()
          .del(this.profileKey(id))
          .srem(PROFILES_INDEX_KEY, id)
          .del(this.walletKey(profile.walletAddress))
          .exec();
        this.assertTransactionOk(results);
        return;
      } catch (err) {
        this.logFallback('delete', err);
      }
    }

    this.walletAddressIndex.delete(profile.walletAddress);
    this.profiles.delete(id);
  }

  /**
   * Rate a user profile
   * Updates the overall rating using a weighted average
   */
  async rateUser(id: string, dto: RateUserDto): Promise<UserProfile> {
    const profile = await this.findById(id);

    // Calculate new rating using weighted average
    const totalRating = profile.rating * profile.ratingCount;
    const newRatingCount = profile.ratingCount + 1;
    const newRating = (totalRating + dto.rating) / newRatingCount;

    profile.rating = Math.round(newRating * 100) / 100; // Round to 2 decimal places
    profile.ratingCount = newRatingCount;
    profile.updatedAt = new Date().toISOString();

    await this.persist(profile);
    return profile;
  }

  /**
   * Increment completed jobs counter
   */
  async incrementCompletedJobs(id: string): Promise<UserProfile> {
    const profile = await this.findById(id);
    profile.completedJobs += 1;
    profile.updatedAt = new Date().toISOString();
    await this.persist(profile);
    return profile;
  }

  /**
   * Update total earned (for freelancers)
   */
  async updateTotalEarned(id: string, amount: string): Promise<UserProfile> {
    parseAmount(amount);
    const profile = await this.findById(id);
    const currentEarned = parseAmount(profile.totalEarned || '0');
    const additionalAmount = parseAmount(amount);
    profile.totalEarned = normalizeAmount(currentEarned.plus(additionalAmount).toFixed());
    profile.updatedAt = new Date().toISOString();
    await this.persist(profile);
    return profile;
  }

  /**
   * Update total spent (for clients)
   */
  async updateTotalSpent(id: string, amount: string): Promise<UserProfile> {
    parseAmount(amount);
    const profile = await this.findById(id);
    const currentSpent = parseAmount(profile.totalSpent || '0');
    const additionalAmount = parseAmount(amount);
    profile.totalSpent = normalizeAmount(currentSpent.plus(additionalAmount).toFixed());
    profile.updatedAt = new Date().toISOString();
    await this.persist(profile);
    return profile;
  }

  /**
   * Verify a user profile
   */
  async verifyUser(id: string): Promise<UserProfile> {
    const profile = await this.findById(id);
    profile.isVerified = true;
    profile.updatedAt = new Date().toISOString();
    await this.persist(profile);
    return profile;
  }

  /**
   * Update last active timestamp
   */
  async updateLastActive(id: string): Promise<void> {
    const profile = await this.findById(id);
    profile.lastActiveAt = new Date().toISOString();
    await this.persist(profile);
  }

  /**
   * Search profiles by name, bio, or skills with relevance ranking.
   * Results are ranked: exact name match > prefix name match > name contains > bio/skills match.
   *
   * Kept as an in-process scan over findAll() rather than a Redis-native query — see the class
   * doc comment.
   */
  async search(
    query: string,
    options?: { offset?: number; limit?: number },
  ): Promise<{ data: UserProfile[]; total: number }> {
    const lowerQuery = query.toLowerCase();
    const all = await this.fetchAll();
    const matches = all
      .filter(
        profile =>
          profile.name.toLowerCase().includes(lowerQuery) ||
          profile.bio?.toLowerCase().includes(lowerQuery) ||
          profile.skills?.some(skill => skill.toLowerCase().includes(lowerQuery)),
      )
      .map(profile => {
        const nameLower = profile.name.toLowerCase();
        let rank = 0;
        if (nameLower === lowerQuery) {
          rank = 4;
        } else if (nameLower.startsWith(lowerQuery)) {
          rank = 3;
        } else if (nameLower.includes(lowerQuery)) {
          rank = 2;
        } else if (profile.bio?.toLowerCase().includes(lowerQuery)) {
          rank = 1;
        }
        return { profile, rank };
      })
      .sort((a, b) => b.rank - a.rank)
      .map(({ profile }) => profile);

    const total = matches.length;
    const offset = options?.offset ?? 0;
    const limit = options?.limit ?? 20;
    const data = matches.slice(offset, offset + limit);
    return { data, total };
  }

  // ─── Persistence helpers ────────────────────────────────────────────

  private async persist(profile: UserProfile): Promise<void> {
    if (this.redis) {
      try {
        const results = await this.redis
          .multi()
          .set(this.profileKey(profile.id), JSON.stringify(profile))
          .exec();
        this.assertTransactionOk(results);
        return;
      } catch (err) {
        this.logFallback('persist', err);
      }
    }
    this.profiles.set(profile.id, profile);
  }

  private async tryFindById(id: string): Promise<UserProfile | undefined> {
    let profile: UserProfile | undefined;
    if (this.redis) {
      try {
        const raw = await this.redis.get(this.profileKey(id));
        profile = raw ? (JSON.parse(raw) as UserProfile) : undefined;
      } catch (err) {
        this.logFallback('findById', err);
      }
    } else {
      profile = this.profiles.get(id);
    }

    if (profile?.deletedAt) return undefined;
    return profile;
  }

  private async tryFindByWalletAddress(walletAddress: string): Promise<UserProfile | undefined> {
    if (this.redis) {
      try {
        const id = await this.redis.get(this.walletKey(walletAddress));
        return id ? await this.tryFindById(id) : undefined;
      } catch (err) {
        this.logFallback('findByWalletAddress', err);
      }
    }

    const profileId = this.walletAddressIndex.get(walletAddress);
    return profileId ? this.profiles.get(profileId) : undefined;
  }

  private async fetchAll(): Promise<UserProfile[]> {
    if (this.redis) {
      try {
        const ids = await this.redis.smembers(PROFILES_INDEX_KEY);
        if (ids.length === 0) return [];
        const raw = await this.redis.mget(...ids.map(id => this.profileKey(id)));
        return raw.filter((r): r is string => r !== null).map(r => JSON.parse(r) as UserProfile);
      } catch (err) {
        this.logFallback('findAll', err);
      }
    }

    return Array.from(this.profiles.values());
  }

  private assertTransactionOk(results: Array<[Error | null, unknown]> | null): void {
    if (!results) {
      throw new Error('Redis transaction aborted (exec() returned null, e.g. a WATCH conflict)');
    }
    const failed = results.find(([err]) => err);
    if (failed) {
      throw new Error(`Redis transaction command failed: ${failed[0]!.message}`);
    }
  }

  private profileKey(id: string): string {
    return `${PROFILE_KEY_PREFIX}${id}`;
  }

  private walletKey(walletAddress: string): string {
    return `${PROFILES_BY_WALLET_PREFIX}${walletAddress}`;
  }

  private logFallback(operation: string, err: unknown): void {
    this.metrics?.increment(USER_PROFILE_PERSISTENCE_FALLBACK_METRIC, { operation });
    this.logger.error(
      `Redis unavailable for userProfile.${operation}, falling back to per-instance memory ` +
        '(multi-instance state will diverge until Redis recovers)',
      err instanceof Error ? err.stack : String(err),
    );
  }
}
