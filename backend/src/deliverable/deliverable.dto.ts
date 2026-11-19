import { z } from 'zod';
import { MAX_BASE64_CONTENT_LENGTH } from '../ipfs-pinning/ipfs-pinning.types';

const STELLAR_ADDRESS_REGEX = /^G[A-Z2-7]{55}$/;
const BASE64_BODY_REGEX = /^[A-Za-z0-9+/]*={0,2}$/;

// Plausible IPFS CID check (#922): CIDv0 (Qm... 46 chars) or CIDv1 (b... or ba...)
export const IPFS_CID_REGEX = /^(Qm[1-9A-HJ-NP-Za-km-z]{44}|b[a-z2-7]{58,}|ba[a-z2-7]{57,})$/;

export function isValidIpfsCid(hash: unknown): boolean {
  if (typeof hash !== 'string') return false;
  const trimmed = hash.trim();
  if (!trimmed || trimmed === 'TODO' || trimmed.toLowerCase() === 'placeholder') return false;
  return IPFS_CID_REGEX.test(trimmed);
}

function isBase64(value: string): boolean {
  return value.length % 4 === 0 && BASE64_BODY_REGEX.test(value);
}

export const UploadDeliverableSchema = z.object({
  gigId: z.string().min(1),
  freelancer: z.string().regex(STELLAR_ADDRESS_REGEX, 'Invalid Stellar address'),
  content: z
    .string()
    .min(1, 'Base64-encoded content is required')
    .max(MAX_BASE64_CONTENT_LENGTH, 'content exceeds the maximum allowed size of 10 MB (decoded)')
    .refine(value => value.length > MAX_BASE64_CONTENT_LENGTH || isBase64(value), {
      message: 'content must be valid base64',
    })
    .optional(),
  fileHash: z
    .string()
    .refine(isValidIpfsCid, { message: 'fileHash must be a valid, non-empty IPFS CID' })
    .optional(),
  filename: z.string().min(1).max(255),
}).refine(data => Boolean(data.content || data.fileHash), {
  message: 'Either content or a valid fileHash must be provided',
});

export type UploadDeliverableDto = z.infer<typeof UploadDeliverableSchema>;

export const ReviewDeliverableSchema = z.object({
  status: z.enum(['APPROVED', 'REJECTED', 'approved', 'rejected']),
  notes: z.string().max(1000).optional(),
});

export type ReviewDeliverableDto = z.infer<typeof ReviewDeliverableSchema>;
