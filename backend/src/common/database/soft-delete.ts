/**
 * Shared soft-delete helper for queries and in-memory stores.
 * Ensures consistent exclusion of soft-deleted rows (deletedAt IS NOT NULL).
 */
export interface SoftDeletable {
  deletedAt?: string | Date | null;
}

/**
 * Filter an array of items to exclude soft-deleted records.
 */
export function excludeSoftDeleted<T extends SoftDeletable>(items: T[]): T[] {
  return items.filter(item => item.deletedAt === undefined || item.deletedAt === null);
}

/**
 * Applies a WHERE deleted_at IS NULL clause to an SQL query string.
 */
export function withSoftDeleteFilter(sqlQuery: string, tableAlias = ''): string {
  const col = tableAlias ? `${tableAlias}.deleted_at` : 'deleted_at';
  const condition = `${col} IS NULL`;
  return sqlQuery.toLowerCase().includes('where')
    ? `${sqlQuery} AND ${condition}`
    : `${sqlQuery} WHERE ${condition}`;
}
