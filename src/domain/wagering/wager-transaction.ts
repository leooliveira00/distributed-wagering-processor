import { type Money } from '../money/money';
import { type FailureCode } from '../shared/failure-code';
import { invertDirection, LedgerDirection } from '../wallet/ledger-direction';
import { WagerTransactionKind } from './wager-transaction-kind';
import { isTerminalStatus, WagerTransactionStatus } from './wager-transaction-status';
import { InvalidTransactionStateError, InvalidWagerTransactionError } from './wagering.errors';

export const INTERNAL_PROVIDER_ID = 'internal';

export interface CreateWagerTransactionProps {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  /** Provider-side id of the referenced transaction, not the internal id. */
  referenceExternalTransactionId?: string | undefined;
  createdAt: Date;
}

export interface CreateOpeningTransactionProps {
  id: string;
  walletId: string;
  playerId: string;
  money: Money;
  payloadHash: string;
  at: Date;
}

export interface WagerTransactionState extends CreateWagerTransactionProps {
  status: WagerTransactionStatus;
  referenceTransactionId: string | undefined;
  failureCode: FailureCode | undefined;
  processedAt: Date | undefined;
  observedBalance: Money | undefined;
  attempts: number;
  nextAttemptAt: Date | undefined;
}

export interface MarkProcessedProps {
  referenceTransactionId: string | undefined;
  /** Wallet balance right after applying the transaction, returned again on replays (rule 7.7). */
  observedBalance: Money;
  at: Date;
}

export interface MarkPendingReferenceProps {
  observedBalance: Money;
  nextAttemptAt: Date;
}

export interface RejectProps {
  observedBalance: Money;
}

/** Kinds each operation may reference (rule 7.3; WIN/LOSS reference is optional, D7). */
const ALLOWED_REFERENCE_KINDS: Readonly<
  Record<WagerTransactionKind, readonly WagerTransactionKind[]>
> = {
  [WagerTransactionKind.Opening]: [],
  [WagerTransactionKind.Bet]: [],
  [WagerTransactionKind.Win]: [WagerTransactionKind.Bet],
  [WagerTransactionKind.Loss]: [WagerTransactionKind.Bet],
  [WagerTransactionKind.Refund]: [WagerTransactionKind.Bet],
  [WagerTransactionKind.Rollback]: [
    WagerTransactionKind.Bet,
    WagerTransactionKind.Win,
    WagerTransactionKind.Refund,
  ],
};

const EXTERNAL_KINDS: ReadonlySet<WagerTransactionKind> = new Set([
  WagerTransactionKind.Bet,
  WagerTransactionKind.Win,
  WagerTransactionKind.Loss,
  WagerTransactionKind.Refund,
  WagerTransactionKind.Rollback,
]);

const PAYLOAD_HASH_PATTERN = /^[0-9a-f]{64}$/;

/**
 * A provider operation and its processing lifecycle.
 *
 * Valid transitions (anything else throws InvalidTransactionStateError):
 *
 *   PENDING           -> PROCESSED | REJECTED | FAILED | PENDING_REFERENCE
 *   PENDING_REFERENCE -> PROCESSED | REJECTED | FAILED | PENDING_REFERENCE (retry)
 *   PROCESSED, REJECTED, FAILED are terminal.
 */
export class WagerTransaction {
  private constructor(
    public readonly id: string,
    public readonly providerId: string,
    public readonly externalTransactionId: string,
    public readonly idempotencyKey: string,
    public readonly payloadHash: string,
    public readonly walletId: string,
    public readonly playerId: string,
    public readonly roundId: string,
    public readonly gameId: string,
    public readonly kind: WagerTransactionKind,
    public readonly money: Money,
    public readonly referenceExternalTransactionId: string | undefined,
    public readonly createdAt: Date,
    private _status: WagerTransactionStatus,
    private _referenceTransactionId: string | undefined,
    private _failureCode: FailureCode | undefined,
    private _processedAt: Date | undefined,
    private _observedBalance: Money | undefined,
    private _attempts: number,
    private _nextAttemptAt: Date | undefined,
  ) {}

  /** Externally submitted operation. Born PENDING; validates reference requirements per kind. */
  static create(props: CreateWagerTransactionProps): WagerTransaction {
    if (!EXTERNAL_KINDS.has(props.kind)) {
      throw new InvalidWagerTransactionError(
        'UNSUPPORTED_KIND',
        `Kind ${props.kind} cannot be submitted externally`,
      );
    }
    WagerTransaction.assertRequiredFields(props);

    const reference = props.referenceExternalTransactionId;
    const transaction = WagerTransaction.pending(props);
    if (transaction.requiresReference() && reference === undefined) {
      throw new InvalidWagerTransactionError(
        'REFERENCE_REQUIRED',
        `${props.kind} requires referenceExternalTransactionId`,
      );
    }
    if (reference !== undefined && !transaction.acceptsReference()) {
      throw new InvalidWagerTransactionError(
        'REFERENCE_NOT_ALLOWED',
        `${props.kind} cannot reference another transaction`,
      );
    }
    if (reference === props.externalTransactionId) {
      throw new InvalidWagerTransactionError(
        'SELF_REFERENCE',
        'A transaction cannot reference itself',
      );
    }
    return transaction;
  }

  /** Internal opening credit, created and applied together with the wallet. */
  static createOpening(props: CreateOpeningTransactionProps): WagerTransaction {
    const transaction = WagerTransaction.pending({
      id: props.id,
      providerId: INTERNAL_PROVIDER_ID,
      externalTransactionId: `opening:${props.walletId}`,
      idempotencyKey: `opening:${props.walletId}`,
      payloadHash: props.payloadHash,
      walletId: props.walletId,
      playerId: props.playerId,
      roundId: 'opening',
      gameId: 'internal',
      kind: WagerTransactionKind.Opening,
      money: props.money,
      referenceExternalTransactionId: undefined,
      createdAt: props.at,
    });
    WagerTransaction.assertRequiredFields(transaction);
    transaction.markProcessed({
      referenceTransactionId: undefined,
      observedBalance: props.money,
      at: props.at,
    });
    return transaction;
  }

  /** Reconstruction from persistence. Does not revalidate transitions. */
  static rehydrate(state: WagerTransactionState): WagerTransaction {
    return new WagerTransaction(
      state.id,
      state.providerId,
      state.externalTransactionId,
      state.idempotencyKey,
      state.payloadHash,
      state.walletId,
      state.playerId,
      state.roundId,
      state.gameId,
      state.kind,
      state.money,
      state.referenceExternalTransactionId,
      new Date(state.createdAt),
      state.status,
      state.referenceTransactionId,
      state.failureCode,
      state.processedAt ? new Date(state.processedAt) : undefined,
      state.observedBalance,
      state.attempts,
      state.nextAttemptAt ? new Date(state.nextAttemptAt) : undefined,
    );
  }

  get status(): WagerTransactionStatus {
    return this._status;
  }

  get referenceTransactionId(): string | undefined {
    return this._referenceTransactionId;
  }

  get failureCode(): FailureCode | undefined {
    return this._failureCode;
  }

  get processedAt(): Date | undefined {
    return this._processedAt ? new Date(this._processedAt) : undefined;
  }

  get observedBalance(): Money | undefined {
    return this._observedBalance;
  }

  /** Number of times the reference could not be resolved. */
  get attempts(): number {
    return this._attempts;
  }

  get nextAttemptAt(): Date | undefined {
    return this._nextAttemptAt ? new Date(this._nextAttemptAt) : undefined;
  }

  // ---- transitions

  markProcessed(props: MarkProcessedProps): void {
    this.transitionTo(WagerTransactionStatus.Processed);
    this._referenceTransactionId = props.referenceTransactionId;
    this._observedBalance = props.observedBalance;
    this._processedAt = new Date(props.at);
    this._nextAttemptAt = undefined;
  }

  markPendingReference(props: MarkPendingReferenceProps): void {
    this.transitionTo(WagerTransactionStatus.PendingReference);
    this._observedBalance = props.observedBalance;
    this._attempts++;
    this._nextAttemptAt = new Date(props.nextAttemptAt);
  }

  reject(code: FailureCode, props: RejectProps): void {
    this.transitionTo(WagerTransactionStatus.Rejected);
    this._failureCode = code;
    this._observedBalance = props.observedBalance;
    this._nextAttemptAt = undefined;
  }

  fail(code: FailureCode): void {
    this.transitionTo(WagerTransactionStatus.Failed);
    this._failureCode = code;
    this._nextAttemptAt = undefined;
  }

  // ---- domain queries

  isTerminal(): boolean {
    return isTerminalStatus(this._status);
  }

  /** LOSS records the outcome without moving the balance. */
  affectsBalance(): boolean {
    return this.kind !== WagerTransactionKind.Loss;
  }

  requiresReference(): boolean {
    return this.kind === WagerTransactionKind.Refund || this.kind === WagerTransactionKind.Rollback;
  }

  acceptsReference(): boolean {
    return ALLOWED_REFERENCE_KINDS[this.kind].length > 0;
  }

  canReference(reference: WagerTransaction): boolean {
    return ALLOWED_REFERENCE_KINDS[this.kind].includes(reference.kind);
  }

  matchesPayload(payloadHash: string): boolean {
    return this.payloadHash === payloadHash;
  }

  /**
   * Direction of the ledger entry this transaction produces.
   * ROLLBACK inverts the direction of its reference (BET -> CREDIT, WIN/REFUND -> DEBIT).
   */
  ledgerDirectionFor(reference?: WagerTransaction): LedgerDirection {
    switch (this.kind) {
      case WagerTransactionKind.Bet:
        return LedgerDirection.Debit;
      case WagerTransactionKind.Opening:
      case WagerTransactionKind.Win:
      case WagerTransactionKind.Refund:
        return LedgerDirection.Credit;
      case WagerTransactionKind.Rollback:
        if (!reference) {
          throw new Error(`ROLLBACK ${this.id} needs its reference to determine the direction`);
        }
        return invertDirection(reference.ledgerDirectionFor());
      case WagerTransactionKind.Loss:
        throw new Error(`LOSS ${this.id} does not produce a ledger entry`);
    }
  }

  private transitionTo(next: WagerTransactionStatus): void {
    if (this.isTerminal()) {
      throw new InvalidTransactionStateError(this.id, this._status, next);
    }
    this._status = next;
  }

  private static pending(props: CreateWagerTransactionProps): WagerTransaction {
    return new WagerTransaction(
      props.id,
      props.providerId,
      props.externalTransactionId,
      props.idempotencyKey,
      props.payloadHash,
      props.walletId,
      props.playerId,
      props.roundId,
      props.gameId,
      props.kind,
      props.money,
      props.referenceExternalTransactionId,
      new Date(props.createdAt),
      WagerTransactionStatus.Pending,
      undefined,
      undefined,
      undefined,
      undefined,
      0,
      undefined,
    );
  }

  private static assertRequiredFields(props: {
    id: string;
    providerId: string;
    externalTransactionId: string;
    idempotencyKey: string;
    payloadHash: string;
    walletId: string;
    playerId: string;
    roundId: string;
    gameId: string;
    money: Money;
  }): void {
    const required = {
      id: props.id,
      providerId: props.providerId,
      externalTransactionId: props.externalTransactionId,
      idempotencyKey: props.idempotencyKey,
      walletId: props.walletId,
      playerId: props.playerId,
      roundId: props.roundId,
      gameId: props.gameId,
    };
    for (const [field, value] of Object.entries(required)) {
      if (value.trim().length === 0) {
        throw new InvalidWagerTransactionError('INVALID_FIELD', `${field} is required`);
      }
    }
    if (!PAYLOAD_HASH_PATTERN.test(props.payloadHash)) {
      throw new InvalidWagerTransactionError(
        'INVALID_FIELD',
        'payloadHash must be a lowercase hex SHA-256 digest',
      );
    }
    if (!props.money.isPositive()) {
      throw new InvalidWagerTransactionError(
        'NON_POSITIVE_AMOUNT',
        'Transaction amount must be greater than zero',
      );
    }
  }
}
