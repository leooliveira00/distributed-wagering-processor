import { InvalidMessageError, InvalidMessageStateError } from './messaging.errors';

export interface ReceiveInboxProps {
  messageId: string;
  consumerName: string;
  payloadHash: string;
  receivedAt: Date;
}

export interface InboxMessageState extends ReceiveInboxProps {
  processedAt: Date | undefined;
}

const PAYLOAD_HASH_PATTERN = /^[0-9a-f]{64}$/;

/**
 * Persistent deduplication record for a consumed message, keyed by (consumerName, messageId).
 * It is written in the same SQL transaction as the financial change, so a redelivered
 * message is recognized even after a crash between commit and ack.
 */
export class InboxMessage {
  private constructor(
    public readonly messageId: string,
    public readonly consumerName: string,
    public readonly payloadHash: string,
    public readonly receivedAt: Date,
    private _processedAt: Date | undefined,
  ) {}

  static receive(props: ReceiveInboxProps): InboxMessage {
    if (props.messageId.trim().length === 0 || props.consumerName.trim().length === 0) {
      throw new InvalidMessageError('messageId and consumerName are required');
    }
    if (!PAYLOAD_HASH_PATTERN.test(props.payloadHash)) {
      throw new InvalidMessageError('payloadHash must be a lowercase hex SHA-256 digest');
    }
    return new InboxMessage(
      props.messageId,
      props.consumerName,
      props.payloadHash,
      new Date(props.receivedAt),
      undefined,
    );
  }

  /** Reconstruction from persistence. Does not revalidate. */
  static rehydrate(state: InboxMessageState): InboxMessage {
    return new InboxMessage(
      state.messageId,
      state.consumerName,
      state.payloadHash,
      new Date(state.receivedAt),
      state.processedAt ? new Date(state.processedAt) : undefined,
    );
  }

  get processedAt(): Date | undefined {
    return this._processedAt ? new Date(this._processedAt) : undefined;
  }

  isProcessed(): boolean {
    return this._processedAt !== undefined;
  }

  /** Same messageId with a different payload is a conflict, not a duplicate. */
  matchesPayload(payloadHash: string): boolean {
    return this.payloadHash === payloadHash;
  }

  markProcessed(at: Date): void {
    if (this._processedAt) {
      throw new InvalidMessageStateError(
        `Inbox message ${this.consumerName}/${this.messageId} is already processed`,
      );
    }
    this._processedAt = new Date(at);
  }
}
