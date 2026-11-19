/**
 * User Profile Entity
 * Represents both freelancers and clients in the TrustFlow platform.
 * Each profile is uniquely identified by their Stellar wallet address.
 */

export enum UserType {
  FREELANCER = 'freelancer',
  CLIENT = 'client',
  BOTH = 'both',
}

export enum UserStatus {
  ACTIVE = 'active',
  INACTIVE = 'inactive',
  SUSPENDED = 'suspended',
}

export class UserProfileEntity {
  /**
   * Unique identifier (UUID)
   */
  id: string;

  /**
   * Stellar wallet address (G-prefixed, 56 characters)
   * Serves as the primary authentication identifier
   */
  walletAddress: string;

  /**
   * Display name for the user
   */
  name: string;

  /**
   * User biography/description
   */
  bio?: string;

  /**
   * Type of user (freelancer, client, or both)
   */
  userType: UserType;

  /**
   * Profile image URL
   */
  avatarUrl?: string;

  /**
   * User's email address (optional)
   */
  email?: string;

  /**
   * Overall rating (0-5 scale)
   */
  rating: number;

  /**
   * Total number of ratings received
   */
  ratingCount: number;

  /**
   * Number of completed jobs/contracts
   */
  completedJobs: number;

  /**
   * Account status
   */
  status: UserStatus;

  /**
   * Skills or expertise tags (for freelancers)
   */
  skills?: string[];

  /**
   * Social media links
   */
  socialLinks?: {
    twitter?: string;
    github?: string;
    linkedin?: string;
    website?: string;
  };

  /**
   * Total amount earned (in XLM) - for freelancers
   */
  totalEarned?: string;

  /**
   * Total amount spent (in XLM) - for clients
   */
  totalSpent?: string;

  /**
   * User verification status
   */
  isVerified: boolean;

  /**
   * Timestamp when the profile was created
   */
  createdAt: Date;

  /**
   * Timestamp when the profile was last updated
   */
  updatedAt: Date;

  /**
   * Timestamp of last activity
   */
  lastActiveAt?: Date;

  /**
   * Timestamp when the profile was soft-deleted, or undefined if active
   */
  deletedAt?: Date | string;
}
