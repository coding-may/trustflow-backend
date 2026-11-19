import { z } from 'zod';
import { GigCategory, GigStatus, MAX_GIG_SEARCH_LIMIT } from './gig.entity';

const STELLAR_ADDRESS_REGEX = /^G[A-Z2-7]{55}$/;

export const CreateGigSchema = z.object({
  creator: z.string().regex(STELLAR_ADDRESS_REGEX, 'Invalid Stellar address'),
  title: z.string().min(1, 'Title is required').max(200, 'Title must not exceed 200 characters'),
  budgetXLM: z.string().regex(/^\d+(\.\d{1,7})?$/, 'Invalid XLM amount'),
  /** Hours to wait for a response before the sweep marks the gig expired. Defaults to 72. */
  responseWindowHours: z
    .number()
    .int()
    .positive()
    .max(24 * 30, 'Response window cannot exceed 30 days')
    .optional(),
  escrowId: z.string().optional(),
  reservationId: z.string().optional(),
});

export type CreateGigDto = z.infer<typeof CreateGigSchema>;

export const AcceptGigSchema = z.object({
  responder: z.string().regex(STELLAR_ADDRESS_REGEX, 'Invalid Stellar address'),
});

export type AcceptGigDto = z.infer<typeof AcceptGigSchema>;

export const UpdateGigSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  budgetXLM: z
    .string()
    .regex(/^\d+(\.\d{1,7})?$/, 'Invalid XLM amount')
    .optional(),
  responseWindowHours: z
    .number()
    .int()
    .positive()
    .max(24 * 30)
    .optional(),
});

export type UpdateGigDto = z.infer<typeof UpdateGigSchema>;

export const SearchGigsSchema = z.object({
  /** Defaults to GigStatus.OPEN in GigService.search() when omitted. */
  status: z.nativeEnum(GigStatus).optional(),
  category: z
    .nativeEnum(GigCategory, {
      errorMap: () => ({ message: 'Invalid category filter' }),
    })
    .optional(),
  page: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().positive().max(MAX_GIG_SEARCH_LIMIT).optional(),
  minBudgetXLM: z.coerce
    .string()
    .regex(/^\d+(\.\d{1,7})?$/, 'Invalid XLM amount')
    .optional(),
  maxBudgetXLM: z.coerce
    .string()
    .regex(/^\d+(\.\d{1,7})?$/, 'Invalid XLM amount')
    .optional(),
});

export type SearchGigsQuery = z.infer<typeof SearchGigsSchema>;
