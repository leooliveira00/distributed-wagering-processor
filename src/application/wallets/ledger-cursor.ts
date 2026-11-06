import { InvalidRequestError } from '../errors';

const PREFIX = 'v1:';

/**
 * Opaque, versioned pagination cursor over the wallet version of the last returned entry.
 * Clients must not interpret it; the `v1` prefix lets the format evolve without breaking them.
 */
export function encodeLedgerCursor(afterVersion: number): string {
  return Buffer.from(`${PREFIX}${String(afterVersion)}`, 'utf8').toString('base64url');
}

export function decodeLedgerCursor(cursor: string): number {
  const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
  const version = decoded.startsWith(PREFIX) ? decoded.slice(PREFIX.length) : '';
  // Round-trip check rejects anything that is not exactly a cursor we issued.
  if (!/^[1-9]\d{0,9}$/.test(version) || encodeLedgerCursor(Number(version)) !== cursor) {
    throw new InvalidRequestError('Invalid pagination cursor', [], 'INVALID_CURSOR');
  }
  return Number(version);
}
