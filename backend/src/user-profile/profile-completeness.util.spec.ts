import {
  calculateProfileCompleteness,
  getProfileCompletenessBreakdown,
  PROFILE_COMPLETENESS_WEIGHTS,
} from './profile-completeness.util';
import { UserProfile } from './user-profile.service';
import { UserType, UserStatus } from './user-profile.entity';

describe('Profile Completeness Utilities', () => {
  const BASE_PROFILE: UserProfile = {
    id: 'test-id',
    walletAddress: 'GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
    name: 'Test User',
    userType: UserType.FREELANCER,
    rating: 0,
    ratingCount: 0,
    completedJobs: 0,
    status: UserStatus.ACTIVE,
    isVerified: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  describe('PROFILE_COMPLETENESS_WEIGHTS configuration', () => {
    it('should sum to exactly 100', () => {
      const total = Object.values(PROFILE_COMPLETENESS_WEIGHTS).reduce(
        (sum, weight) => sum + weight,
        0,
      );
      expect(total).toBe(100);
    });

    it('should not contain duplicate field names', () => {
      const keys = Object.keys(PROFILE_COMPLETENESS_WEIGHTS);
      const uniqueKeys = new Set(keys);
      expect(keys.length).toBe(uniqueKeys.size);
    });

    it('should include all expected profile fields', () => {
      const expectedFields = [
        'name',
        'bio',
        'avatarUrl',
        'email',
        'skills',
        'socialLinks',
        'userType',
        'isVerified',
      ];

      for (const field of expectedFields) {
        expect(PROFILE_COMPLETENESS_WEIGHTS).toHaveProperty(field);
        expect(typeof PROFILE_COMPLETENESS_WEIGHTS[field]).toBe('number');
        expect(PROFILE_COMPLETENESS_WEIGHTS[field]).toBeGreaterThan(0);
      }
    });

    // Regression test for #982: bio should appear exactly once
    it('should not contain bio field more than once (regression test for #982)', () => {
      const bioOccurrences = Object.keys(PROFILE_COMPLETENESS_WEIGHTS).filter(
        key => key === 'bio' || key.toLowerCase().includes('bio'),
      );
      expect(bioOccurrences.length).toBe(1);
      expect(bioOccurrences[0]).toBe('bio');
    });
  });

  describe('calculateProfileCompleteness()', () => {
    it('should return name + userType weight for a minimal profile (required fields only)', () => {
      const profile = { ...BASE_PROFILE };
      const expected = PROFILE_COMPLETENESS_WEIGHTS.name + PROFILE_COMPLETENESS_WEIGHTS.userType;
      expect(calculateProfileCompleteness(profile)).toBe(expected);
    });

    it('should add bio weight when bio is present', () => {
      const profile = { ...BASE_PROFILE, bio: 'A passionate developer' };
      const expected =
        PROFILE_COMPLETENESS_WEIGHTS.name +
        PROFILE_COMPLETENESS_WEIGHTS.userType +
        PROFILE_COMPLETENESS_WEIGHTS.bio;
      expect(calculateProfileCompleteness(profile)).toBe(expected);
    });

    it('should not add bio weight when bio is empty string', () => {
      const profile = { ...BASE_PROFILE, bio: '' };
      const expected = PROFILE_COMPLETENESS_WEIGHTS.name + PROFILE_COMPLETENESS_WEIGHTS.userType;
      expect(calculateProfileCompleteness(profile)).toBe(expected);
    });

    it('should not add bio weight when bio is whitespace only', () => {
      const profile = { ...BASE_PROFILE, bio: '   ' };
      const expected = PROFILE_COMPLETENESS_WEIGHTS.name + PROFILE_COMPLETENESS_WEIGHTS.userType;
      expect(calculateProfileCompleteness(profile)).toBe(expected);
    });

    it('should add avatarUrl weight when avatar is present', () => {
      const profile = { ...BASE_PROFILE, avatarUrl: 'https://example.com/avatar.jpg' };
      const expected =
        PROFILE_COMPLETENESS_WEIGHTS.name +
        PROFILE_COMPLETENESS_WEIGHTS.userType +
        PROFILE_COMPLETENESS_WEIGHTS.avatarUrl;
      expect(calculateProfileCompleteness(profile)).toBe(expected);
    });

    it('should add email weight when email is present', () => {
      const profile = { ...BASE_PROFILE, email: 'test@example.com' };
      const expected =
        PROFILE_COMPLETENESS_WEIGHTS.name +
        PROFILE_COMPLETENESS_WEIGHTS.userType +
        PROFILE_COMPLETENESS_WEIGHTS.email;
      expect(calculateProfileCompleteness(profile)).toBe(expected);
    });

    it('should add skills weight when at least one skill is present', () => {
      const profile = { ...BASE_PROFILE, skills: ['TypeScript'] };
      const expected =
        PROFILE_COMPLETENESS_WEIGHTS.name +
        PROFILE_COMPLETENESS_WEIGHTS.userType +
        PROFILE_COMPLETENESS_WEIGHTS.skills;
      expect(calculateProfileCompleteness(profile)).toBe(expected);
    });

    it('should not add skills weight for empty skills array', () => {
      const profile = { ...BASE_PROFILE, skills: [] };
      const expected = PROFILE_COMPLETENESS_WEIGHTS.name + PROFILE_COMPLETENESS_WEIGHTS.userType;
      expect(calculateProfileCompleteness(profile)).toBe(expected);
    });

    it('should add socialLinks weight when at least one social link is present', () => {
      const profile = {
        ...BASE_PROFILE,
        socialLinks: { twitter: 'https://twitter.com/test' },
      };
      const expected =
        PROFILE_COMPLETENESS_WEIGHTS.name +
        PROFILE_COMPLETENESS_WEIGHTS.userType +
        PROFILE_COMPLETENESS_WEIGHTS.socialLinks;
      expect(calculateProfileCompleteness(profile)).toBe(expected);
    });

    it('should add socialLinks weight when github is present', () => {
      const profile = {
        ...BASE_PROFILE,
        socialLinks: { github: 'https://github.com/test' },
      };
      const expected =
        PROFILE_COMPLETENESS_WEIGHTS.name +
        PROFILE_COMPLETENESS_WEIGHTS.userType +
        PROFILE_COMPLETENESS_WEIGHTS.socialLinks;
      expect(calculateProfileCompleteness(profile)).toBe(expected);
    });

    it('should not add socialLinks weight when all links are empty', () => {
      const profile = {
        ...BASE_PROFILE,
        socialLinks: { twitter: '', github: '', linkedin: '', website: '' },
      };
      const expected = PROFILE_COMPLETENESS_WEIGHTS.name + PROFILE_COMPLETENESS_WEIGHTS.userType;
      expect(calculateProfileCompleteness(profile)).toBe(expected);
    });

    it('should add isVerified weight when profile is verified', () => {
      const profile = { ...BASE_PROFILE, isVerified: true };
      const expected =
        PROFILE_COMPLETENESS_WEIGHTS.name +
        PROFILE_COMPLETENESS_WEIGHTS.userType +
        PROFILE_COMPLETENESS_WEIGHTS.isVerified;
      expect(calculateProfileCompleteness(profile)).toBe(expected);
    });

    it('should return 100 for a fully complete profile', () => {
      const profile: UserProfile = {
        ...BASE_PROFILE,
        bio: 'Full bio',
        avatarUrl: 'https://example.com/avatar.jpg',
        email: 'test@example.com',
        skills: ['TypeScript', 'Node.js'],
        socialLinks: {
          twitter: 'https://twitter.com/test',
          github: 'https://github.com/test',
          linkedin: 'https://linkedin.com/in/test',
          website: 'https://test.dev',
        },
        isVerified: true,
      };
      expect(calculateProfileCompleteness(profile)).toBe(100);
    });

    // Regression test for #982: ensure bio is counted only once
    it('should count bio field only once, not inflating the total (regression test for #982)', () => {
      const profileWithOnlyBio: UserProfile = {
        ...BASE_PROFILE,
        bio: 'This is my bio',
      };

      const completeness = calculateProfileCompleteness(profileWithOnlyBio);
      const expectedContribution =
        PROFILE_COMPLETENESS_WEIGHTS.name +
        PROFILE_COMPLETENESS_WEIGHTS.userType +
        PROFILE_COMPLETENESS_WEIGHTS.bio;

      expect(completeness).toBe(expectedContribution);

      // The bio should contribute exactly its documented weight (15), not double
      expect(completeness).toBeLessThanOrEqual(100);
      expect(completeness).toBe(expectedContribution);
    });
  });

  describe('getProfileCompletenessBreakdown()', () => {
    it('should return a breakdown with all fields', () => {
      const profile = { ...BASE_PROFILE };
      const breakdown = getProfileCompletenessBreakdown(profile);

      expect(breakdown).toHaveProperty('totalCompleteness');
      expect(breakdown).toHaveProperty('fields');
      expect(Array.isArray(breakdown.fields)).toBe(true);
      expect(breakdown.fields.length).toBe(8); // All tracked fields
    });

    it('should mark completed fields correctly', () => {
      const profile: UserProfile = {
        ...BASE_PROFILE,
        bio: 'Bio text',
        email: 'test@example.com',
      };

      const breakdown = getProfileCompletenessBreakdown(profile);

      const bioField = breakdown.fields.find(f => f.fieldName === 'bio');
      const emailField = breakdown.fields.find(f => f.fieldName === 'email');
      const avatarField = breakdown.fields.find(f => f.fieldName === 'avatarUrl');

      expect(bioField?.completed).toBe(true);
      expect(bioField?.contribution).toBe(PROFILE_COMPLETENESS_WEIGHTS.bio);

      expect(emailField?.completed).toBe(true);
      expect(emailField?.contribution).toBe(PROFILE_COMPLETENESS_WEIGHTS.email);

      expect(avatarField?.completed).toBe(false);
      expect(avatarField?.contribution).toBe(0);
    });

    it('should calculate total completeness matching calculateProfileCompleteness()', () => {
      const profile: UserProfile = {
        ...BASE_PROFILE,
        bio: 'Bio',
        avatarUrl: 'https://example.com/avatar.jpg',
        skills: ['Rust'],
        isVerified: true,
      };

      const breakdown = getProfileCompletenessBreakdown(profile);
      const directCalculation = calculateProfileCompleteness(profile);

      expect(breakdown.totalCompleteness).toBe(directCalculation);
    });

    it('should include weight information for each field', () => {
      const profile = { ...BASE_PROFILE };
      const breakdown = getProfileCompletenessBreakdown(profile);

      for (const field of breakdown.fields) {
        expect(field).toHaveProperty('fieldName');
        expect(field).toHaveProperty('weight');
        expect(field).toHaveProperty('completed');
        expect(field).toHaveProperty('contribution');

        expect(typeof field.fieldName).toBe('string');
        expect(typeof field.weight).toBe('number');
        expect(typeof field.completed).toBe('boolean');
        expect(typeof field.contribution).toBe('number');
      }
    });

    it('should sum field contributions to match totalCompleteness', () => {
      const profile: UserProfile = {
        ...BASE_PROFILE,
        bio: 'Bio',
        email: 'test@example.com',
      };

      const breakdown = getProfileCompletenessBreakdown(profile);
      const sumOfContributions = breakdown.fields.reduce(
        (sum, field) => sum + field.contribution,
        0,
      );

      expect(breakdown.totalCompleteness).toBe(Math.round(sumOfContributions * 100) / 100);
    });
  });
});
