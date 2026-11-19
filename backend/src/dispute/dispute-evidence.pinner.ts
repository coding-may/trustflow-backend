/**
 * Injection token for the storage backend used by dispute evidence uploads.
 *
 * Kept as an interface + token rather than a concrete import so the saga does not depend on
 * the IPFS provider implementation (and so unit tests of the saga don't pull in provider code).
 */
export const DISPUTE_EVIDENCE_PINNER = 'DISPUTE_EVIDENCE_PINNER';

export interface DisputeEvidencePinner {
  pinContent(dto: { content: string; filename?: string }): Promise<{ cid: string; size: number }>;
}
