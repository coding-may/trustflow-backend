import { excludeSoftDeleted, withSoftDeleteFilter } from './soft-delete';

describe('soft-delete helper', () => {
  it('excludes soft-deleted items with deletedAt set', () => {
    const items = [
      { id: '1', name: 'active' },
      { id: '2', name: 'deleted', deletedAt: '2026-11-19T12:00:00Z' },
      { id: '3', name: 'null-deleted', deletedAt: null },
      { id: '4', name: 'date-deleted', deletedAt: new Date() },
    ];

    const result = excludeSoftDeleted(items);
    expect(result).toHaveLength(2);
    expect(result.map(r => r.id)).toEqual(['1', '3']);
  });

  it('appends soft-delete SQL condition to queries', () => {
    expect(withSoftDeleteFilter('SELECT * FROM gigs')).toBe('SELECT * FROM gigs WHERE deleted_at IS NULL');
    expect(withSoftDeleteFilter('SELECT * FROM gigs WHERE status = $1')).toBe(
      'SELECT * FROM gigs WHERE status = $1 AND deleted_at IS NULL',
    );
    expect(withSoftDeleteFilter('SELECT * FROM gigs g', 'g')).toBe('SELECT * FROM gigs g WHERE g.deleted_at IS NULL');
  });
});
