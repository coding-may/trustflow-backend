import { z } from 'zod';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

// ── Zod schemas (validation) ──────────────────────────────────────────────────

/** Shared URL refinement: must parse and must use https. */
const httpsUrl = z
  .string()
  .url('Must be a valid URL')
  .refine(
    url => {
      try {
        return new URL(url).protocol === 'https:';
      } catch {
        return false;
      }
    },
    { message: 'Webhook URL must use https' },
  );

export const CreateWebhookSubscriptionSchema = z.object({
  dappId: z.string().min(1, 'dappId is required'),
  url: httpsUrl,
  topics: z.array(z.string().min(1).max(128)).min(1, 'At least one topic is required'),
  secret: z
    .string()
    .min(16, 'Secret must be at least 16 characters')
    .max(256)
    .optional(),
});

export const UpdateWebhookSubscriptionSchema = z
  .object({
    dappId: z.string().min(1, 'dappId must not be empty').optional(),
    url: httpsUrl.optional(),
    topics: z.array(z.string().min(1).max(128)).min(1).optional(),
    secret: z
      .string()
      .min(16, 'Secret must be at least 16 characters')
      .max(256)
      .optional(),
  })
  .refine(data => Object.keys(data).length > 0, {
    message: 'At least one field must be provided',
  });

export const WebhookSubscriptionResponseSchema = z.object({
  id: z.string().uuid(),
  dappId: z.string().min(1),
  url: z.string(),
  topics: z.array(z.string()),
  secret: z.string().optional(),
  secretRotationGraceUntil: z.string().datetime().optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

// ── TypeScript types ─────────────────────────────────────────────────────────

export type CreateWebhookSubscriptionDto = z.input<typeof CreateWebhookSubscriptionSchema>;
export type UpdateWebhookSubscriptionDto = z.input<typeof UpdateWebhookSubscriptionSchema>;
export type WebhookSubscriptionResponse = z.input<typeof WebhookSubscriptionResponseSchema>;

/**
 * Mask a signing secret for API responses — only the first 4 characters are
 * exposed so dApps can recognise which secret is configured without the
 * secret value itself being readable.
 */
export function maskSecret(secret: string): string {
  return `${secret.slice(0, 4)}****`;
}

// ── Swagger response shape ────────────────────────────────────────────────────

export class WebhookSubscriptionResponseDto {
  @ApiProperty({ description: 'Unique subscription ID (UUID)' })
  id!: string;

  @ApiProperty({ description: 'ID of the dApp that owns this subscription' })
  dappId!: string;

  @ApiProperty({ description: 'Destination endpoint URL (https)' })
  url!: string;

  @ApiProperty({
    description: 'Event topics this subscription listens for',
    type: [String],
  })
  topics!: string[];

  @ApiPropertyOptional({
    description: 'Signing secret, masked (first 4 characters only)',
  })
  secret?: string;

  @ApiPropertyOptional({
    description:
      'Present only right after a secret rotation: the previous secret is still accepted ' +
      '(dual-signed alongside the new one) until this timestamp (ISO-8601), then fully retired.',
  })
  secretRotationGraceUntil?: string;

  @ApiProperty({ description: 'Creation timestamp (ISO-8601)' })
  createdAt!: string;

  @ApiProperty({ description: 'Last-update timestamp (ISO-8601)' })
  updatedAt!: string;
}
