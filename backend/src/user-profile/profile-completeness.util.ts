import { UserProfile } from './user-profile.service';

/**
 * Weight configuration for profile completeness calculation.
 * Each field contributes a specific percentage towards the total completeness score.
 * Total must sum to exactly 100.
 *
 * NOTE: This configuration was reorganized to fix #982 — the bio field was previously
 * listed twice with different weights, inflating the completeness score for profiles
 * that had a bio set.
 */
export const PROFILE_COMPLETENESS_WEIGHTS: Record<string, number> = {
  name: 10, // Required field, but counts towards completeness
  bio: 15, // Personal description
  avatarUrl: 15, // Profile picture
  email: 10, // Contact information
  skills: 20, // Skills array (for freelancers)
  socialLinks: 15, // Social media links (twitter, github, linkedin, website)
  userType: 5, // Required field
  isVerified: 10, // Verification status
};

/**
 * Validates that profile completeness weights sum to exactly 100.
 * This guard runs at module import time to catch configuration errors early.
 */
function validateWeights(): void {
  const total = Object.values(PROFILE_COMPLETENESS_WEIGHTS).reduce((sum, weight) => sum + weight, 0);
  if (total !== 100) {
    throw new Error(
      `PROFILE_COMPLETENESS_WEIGHTS must sum to exactly 100, got ${total}. ` +
        `Check for duplicate entries or incorrect values.`,
    );
  }

  // Ensure no field name appears more than once (TypeScript won't catch duplicate keys)
  const keys = Object.keys(PROFILE_COMPLETENESS_WEIGHTS);
  const uniqueKeys = new Set(keys);
  if (keys.length !== uniqueKeys.size) {
    throw new Error(
      `PROFILE_COMPLETENESS_WEIGHTS contains duplicate field names. ` +
        `Each profile field must appear exactly once.`,
    );
  }
}

// Validate weights at module load time
validateWeights();

/**
 * Calculates the completeness percentage of a user profile based on weighted fields.
 * Returns a value between 0 and 100.
 *
 * @param profile - The user profile to calculate completeness for
 * @returns Completeness percentage (0-100)
 */
export function calculateProfileCompleteness(profile: UserProfile): number {
  let completeness = 0;

  // name - always present (required field), contributes its full weight
  if (profile.name) {
    completeness += PROFILE_COMPLETENESS_WEIGHTS.name;
  }

  // bio - optional text field
  if (profile.bio && profile.bio.trim().length > 0) {
    completeness += PROFILE_COMPLETENESS_WEIGHTS.bio;
  }

  // avatarUrl - profile picture
  if (profile.avatarUrl && profile.avatarUrl.trim().length > 0) {
    completeness += PROFILE_COMPLETENESS_WEIGHTS.avatarUrl;
  }

  // email - contact information
  if (profile.email && profile.email.trim().length > 0) {
    completeness += PROFILE_COMPLETENESS_WEIGHTS.email;
  }

  // skills - array of skills (meaningful if has at least one skill)
  if (profile.skills && profile.skills.length > 0) {
    completeness += PROFILE_COMPLETENESS_WEIGHTS.skills;
  }

  // socialLinks - at least one social link present
  if (profile.socialLinks) {
    const hasAnySocialLink =
      (profile.socialLinks.twitter && profile.socialLinks.twitter.trim().length > 0) ||
      (profile.socialLinks.github && profile.socialLinks.github.trim().length > 0) ||
      (profile.socialLinks.linkedin && profile.socialLinks.linkedin.trim().length > 0) ||
      (profile.socialLinks.website && profile.socialLinks.website.trim().length > 0);

    if (hasAnySocialLink) {
      completeness += PROFILE_COMPLETENESS_WEIGHTS.socialLinks;
    }
  }

  // userType - always present (required field), contributes its full weight
  if (profile.userType) {
    completeness += PROFILE_COMPLETENESS_WEIGHTS.userType;
  }

  // isVerified - verification status
  if (profile.isVerified) {
    completeness += PROFILE_COMPLETENESS_WEIGHTS.isVerified;
  }

  return Math.round(completeness * 100) / 100; // Round to 2 decimal places
}

/**
 * Returns detailed breakdown of profile completeness by field.
 * Useful for showing users which fields they should complete.
 */
export interface ProfileCompletenessBreakdown {
  totalCompleteness: number;
  fields: {
    fieldName: string;
    weight: number;
    completed: boolean;
    contribution: number;
  }[];
}

export function getProfileCompletenessBreakdown(profile: UserProfile): ProfileCompletenessBreakdown {
  const fields = [
    {
      fieldName: 'name',
      weight: PROFILE_COMPLETENESS_WEIGHTS.name,
      completed: Boolean(profile.name),
      contribution: profile.name ? PROFILE_COMPLETENESS_WEIGHTS.name : 0,
    },
    {
      fieldName: 'bio',
      weight: PROFILE_COMPLETENESS_WEIGHTS.bio,
      completed: Boolean(profile.bio && profile.bio.trim().length > 0),
      contribution:
        profile.bio && profile.bio.trim().length > 0 ? PROFILE_COMPLETENESS_WEIGHTS.bio : 0,
    },
    {
      fieldName: 'avatarUrl',
      weight: PROFILE_COMPLETENESS_WEIGHTS.avatarUrl,
      completed: Boolean(profile.avatarUrl && profile.avatarUrl.trim().length > 0),
      contribution:
        profile.avatarUrl && profile.avatarUrl.trim().length > 0
          ? PROFILE_COMPLETENESS_WEIGHTS.avatarUrl
          : 0,
    },
    {
      fieldName: 'email',
      weight: PROFILE_COMPLETENESS_WEIGHTS.email,
      completed: Boolean(profile.email && profile.email.trim().length > 0),
      contribution:
        profile.email && profile.email.trim().length > 0 ? PROFILE_COMPLETENESS_WEIGHTS.email : 0,
    },
    {
      fieldName: 'skills',
      weight: PROFILE_COMPLETENESS_WEIGHTS.skills,
      completed: Boolean(profile.skills && profile.skills.length > 0),
      contribution:
        profile.skills && profile.skills.length > 0 ? PROFILE_COMPLETENESS_WEIGHTS.skills : 0,
    },
    {
      fieldName: 'socialLinks',
      weight: PROFILE_COMPLETENESS_WEIGHTS.socialLinks,
      completed: Boolean(
        profile.socialLinks &&
          ((profile.socialLinks.twitter && profile.socialLinks.twitter.trim().length > 0) ||
            (profile.socialLinks.github && profile.socialLinks.github.trim().length > 0) ||
            (profile.socialLinks.linkedin && profile.socialLinks.linkedin.trim().length > 0) ||
            (profile.socialLinks.website && profile.socialLinks.website.trim().length > 0)),
      ),
      contribution:
        profile.socialLinks &&
        ((profile.socialLinks.twitter && profile.socialLinks.twitter.trim().length > 0) ||
          (profile.socialLinks.github && profile.socialLinks.github.trim().length > 0) ||
          (profile.socialLinks.linkedin && profile.socialLinks.linkedin.trim().length > 0) ||
          (profile.socialLinks.website && profile.socialLinks.website.trim().length > 0))
          ? PROFILE_COMPLETENESS_WEIGHTS.socialLinks
          : 0,
    },
    {
      fieldName: 'userType',
      weight: PROFILE_COMPLETENESS_WEIGHTS.userType,
      completed: Boolean(profile.userType),
      contribution: profile.userType ? PROFILE_COMPLETENESS_WEIGHTS.userType : 0,
    },
    {
      fieldName: 'isVerified',
      weight: PROFILE_COMPLETENESS_WEIGHTS.isVerified,
      completed: profile.isVerified === true,
      contribution: profile.isVerified ? PROFILE_COMPLETENESS_WEIGHTS.isVerified : 0,
    },
  ];

  const totalCompleteness = fields.reduce((sum, field) => sum + field.contribution, 0);

  return {
    totalCompleteness: Math.round(totalCompleteness * 100) / 100,
    fields,
  };
}
