# Profile Completeness Feature

## Overview

The profile completeness feature calculates a percentage score (0-100) indicating how complete a user's profile is based on weighted field completion. This helps users understand what information they should add to improve their profile.

## Implementation

### Weight Configuration

Profile fields are assigned weights that sum to exactly 100:

| Field | Weight | Description |
|-------|--------|-------------|
| `name` | 10 | User's display name (required field) |
| `bio` | 15 | Personal biography/description |
| `avatarUrl` | 15 | Profile picture URL |
| `email` | 10 | Contact email address |
| `skills` | 20 | Array of skills (requires at least 1 skill) |
| `socialLinks` | 15 | Social media links (requires at least 1 link) |
| `userType` | 5 | Account type (required field) |
| `isVerified` | 10 | Verification status |

**Total:** 100%

### API Endpoints

#### `GET /profiles/me/completeness`
Returns the completeness percentage for the authenticated user.

**Authentication:** Required (JWT)

**Response:**
```json
{
  "completeness": 65
}
```

#### `GET /profiles/me/completeness/breakdown`
Returns detailed breakdown showing which fields are completed and their contributions.

**Authentication:** Required (JWT)

**Response:**
```json
{
  "totalCompleteness": 65,
  "fields": [
    {
      "fieldName": "name",
      "weight": 10,
      "completed": true,
      "contribution": 10
    },
    {
      "fieldName": "bio",
      "weight": 15,
      "completed": true,
      "contribution": 15
    },
    {
      "fieldName": "avatarUrl",
      "weight": 15,
      "completed": false,
      "contribution": 0
    }
    // ... more fields
  ]
}
```

#### `GET /profiles/:id/completeness`
Returns the completeness percentage for any profile by ID.

**Authentication:** Not required (public endpoint)

**Response:**
```json
{
  "completeness": 85
}
```

## Bug Fix (#982)

This implementation fixes issue #982 where the `bio` field was accidentally counted twice with different weights during a previous refactor. The fix ensures:

1. Each field appears exactly once in the weights configuration
2. The weights sum to exactly 100
3. Validation runs at module load time to catch configuration errors early
4. Comprehensive tests prevent regression

### Validation

The module includes startup validation that:
- Verifies weights sum to exactly 100
- Ensures no duplicate field names exist
- Throws an error if configuration is invalid

### Tests

The test suite includes:
- Weight configuration validation
- Completeness calculation for various profile states
- Regression test specifically for the bio double-counting bug
- Breakdown accuracy verification

## Usage Example

```typescript
import {
  calculateProfileCompleteness,
  getProfileCompletenessBreakdown
} from './profile-completeness.util';

// Calculate simple percentage
const completeness = calculateProfileCompleteness(userProfile);
console.log(`Profile is ${completeness}% complete`);

// Get detailed breakdown
const breakdown = getProfileCompletenessBreakdown(userProfile);
console.log(`Total: ${breakdown.totalCompleteness}%`);
breakdown.fields.forEach(field => {
  console.log(`${field.fieldName}: ${field.completed ? '✓' : '✗'} (${field.weight}%)`);
});
```

## Future Enhancements

Potential improvements for future iterations:

1. **Configurable Weights**: Allow admin configuration of field weights
2. **User Type Specific Weights**: Different weights for freelancers vs clients
3. **Progressive Disclosure**: Show next most important field to complete
4. **Gamification**: Badges or rewards for profile completion milestones
5. **Email Notifications**: Remind users to complete their profiles
