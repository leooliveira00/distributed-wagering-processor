export enum WagerTransactionStatus {
  /** Accepted, not applied yet. */
  Pending = 'PENDING',
  /** Waiting for the referenced transaction to arrive. */
  PendingReference = 'PENDING_REFERENCE',
  /** Applied. Terminal. */
  Processed = 'PROCESSED',
  /** Business rule violation. Terminal. */
  Rejected = 'REJECTED',
  /** Permanent infrastructure error. Terminal and auditable. */
  Failed = 'FAILED',
}

const TERMINAL_STATUSES: ReadonlySet<WagerTransactionStatus> = new Set([
  WagerTransactionStatus.Processed,
  WagerTransactionStatus.Rejected,
  WagerTransactionStatus.Failed,
]);

export function isTerminalStatus(status: WagerTransactionStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}
