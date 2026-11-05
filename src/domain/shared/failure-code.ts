/**
 * Stable, machine-readable reasons persisted on REJECTED and FAILED transactions (README §7.2).
 * Providers use them to decide whether to resend, fix the payload or give up.
 *
 * Contract-level errors that never produce a persisted transaction (invalid payload,
 * idempotency conflict, unknown wallet, transient infrastructure failures) are API error
 * codes and live at the interface layer, not here.
 */
export enum FailureCode {
  /** The player in the request does not own the wallet. */
  PlayerWalletMismatch = 'PLAYER_WALLET_MISMATCH',
  /** The operation currency differs from the wallet currency. */
  CurrencyMismatch = 'CURRENCY_MISMATCH',
  /** A BET would make the balance negative. */
  InsufficientFunds = 'INSUFFICIENT_FUNDS',
  /** A reversal (ROLLBACK of a credit) would make the balance negative (rule 7.9). */
  ReversalInsufficientFunds = 'REVERSAL_INSUFFICIENT_FUNDS',
  /** The referenced transaction never arrived within the retry limit (rule 7.1). */
  ReferenceNotFound = 'REFERENCE_NOT_FOUND',
  /** The referenced transaction kind cannot be targeted by this operation (rule 7.3). */
  ReferenceKindNotAllowed = 'REFERENCE_KIND_NOT_ALLOWED',
  /** Provider, player, wallet, currency or round differ from the reference (rule 7.2). */
  ReferenceContextMismatch = 'REFERENCE_CONTEXT_MISMATCH',
  /** The reference reached a terminal state other than PROCESSED. */
  ReferenceNotProcessed = 'REFERENCE_NOT_PROCESSED',
  /** The reference was already reversed by a REFUND or ROLLBACK (rule 7.4, stricter reading). */
  ReferenceAlreadyReversed = 'REFERENCE_ALREADY_REVERSED',
  /** REFUND/ROLLBACK amount differs from the reference amount (rule 7.5). */
  ReferenceAmountMismatch = 'REFERENCE_AMOUNT_MISMATCH',
  /** Permanent infrastructure failure; terminal and auditable (status FAILED). */
  ProcessingFailed = 'PROCESSING_FAILED',
}
