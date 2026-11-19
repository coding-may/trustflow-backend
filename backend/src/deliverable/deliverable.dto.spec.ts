import { UploadDeliverableSchema } from './deliverable.dto';
import { MAX_BASE64_CONTENT_LENGTH } from '../ipfs-pinning/ipfs-pinning.types';

const FREELANCER = 'G' + 'A'.repeat(55);

function parse(content: string) {
  return UploadDeliverableSchema.safeParse({
    gigId: 'gig-1',
    freelancer: FREELANCER,
    content,
    filename: 'report.pdf',
  });
}

describe('UploadDeliverableSchema content', () => {
  it.each([
    ['padded base64', Buffer.from('test file').toString('base64')],
    ['double padded base64', Buffer.from('test fil').toString('base64')],
    ['whole groups without padding', Buffer.from('abc').toString('base64')],
    ['+ and / characters', Buffer.from([0xfb, 0xff, 0xfe]).toString('base64')],
  ])('accepts %s', (_name, content) => {
    expect(parse(content).success).toBe(true);
  });

  it('accepts a real base64 payload', () => {
    expect(parse(Buffer.from('hello deliverable').toString('base64')).success).toBe(true);
  });

  it.each([
    ['characters outside the alphabet', 'not base64 at all!!!'],
    ['url-safe alphabet', 'ab-_'],
    ['whitespace inside', 'QUJD REVG'],
    ['a length that is not a multiple of 4', 'QUJDR'],
    ['padding in the middle', 'QU=DREVG'],
    ['too much padding', 'Q==='],
    ['padding only', '===='],
  ])('rejects %s before any decoding', (_name, content) => {
    const result = parse(content);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.errors[0].message).toBe('content must be valid base64');
    }
  });

  it('rejects an empty payload', () => {
    expect(parse('').success).toBe(false);
  });

  it('accepts a payload exactly at the encoded length limit', () => {
    expect(parse('A'.repeat(MAX_BASE64_CONTENT_LENGTH)).success).toBe(true);
  });

  it('rejects an oversized payload with the size message, not a base64 one', () => {
    const result = parse('A'.repeat(MAX_BASE64_CONTENT_LENGTH + 4));

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.errors.map(e => e.message)).toEqual([
        'content exceeds the maximum allowed size of 10 MB (decoded)',
      ]);
    }
  });

  it('uses the same encoded-length cap as the IPFS pin endpoint', () => {
    expect(MAX_BASE64_CONTENT_LENGTH).toBe(14_316_560);
  });

  describe('fileHash validation (#922)', () => {
    it('accepts a valid IPFS CIDv0 or CIDv1 in fileHash', () => {
      const cidV0 = 'QmXoypizjW3WknFiJnKLwHCnL72vedxjQkDDP1mXWo6uco';
      const result = UploadDeliverableSchema.safeParse({
        gigId: 'gig-1',
        freelancer: FREELANCER,
        fileHash: cidV0,
        filename: 'report.pdf',
      });
      expect(result.success).toBe(true);
    });

    it('rejects an empty fileHash', () => {
      const result = UploadDeliverableSchema.safeParse({
        gigId: 'gig-1',
        freelancer: FREELANCER,
        fileHash: '',
        filename: 'report.pdf',
      });
      expect(result.success).toBe(false);
    });

    it('rejects placeholder fileHash like "TODO"', () => {
      const result = UploadDeliverableSchema.safeParse({
        gigId: 'gig-1',
        freelancer: FREELANCER,
        fileHash: 'TODO',
        filename: 'report.pdf',
      });
      expect(result.success).toBe(false);
    });
  });
});
