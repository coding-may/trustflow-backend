/** Parses a comma-separated ADMIN_ADDRESSES value into a trimmed, deduplicated set. */
export function parseAdminAddresses(adminAddressesCsv: string | undefined): Set<string> {
  return new Set(
    (adminAddressesCsv ?? '')
      .split(',')
      .map(address => address.trim())
      .filter(Boolean),
  );
}

/** Whether `address` is allow-listed in a comma-separated ADMIN_ADDRESSES value. */
export function isAdminAddress(
  address: string | undefined,
  adminAddressesCsv: string | undefined,
): boolean {
  return !!address && parseAdminAddresses(adminAddressesCsv).has(address);
}
